/**
session.ts

GNU source level debugger.

The DebugSession is the adapter code for Visual Studio Code.

@file
@copyright   Atomclip, all rights reserved
@author      Carl van Heezik
@version     0.0.1
@since       2018-06-29
*/
'use strict';
import * as vscode from 'vscode';
import * as os from 'os';

import {
	DebugSession,
	InitializedEvent, TerminatedEvent,
	OutputEvent,
	StoppedEvent, ContinuedEvent,

	Thread, StackFrame, Source, Scope, Breakpoint,
} from 'vscode-debugadapter';
import {
	DebugProtocol
} from 'vscode-debugprotocol';
import * as gdbMI from './parser';
const { spawn } = require('child_process');
// const { spawnSync } = require('child_process');

/*
These constants are used to discriminate between different variables in
the variablesRequestFunction
*/
const REGISTER_SCOPE = 1;
const CUSTOM_SCOPE = 2;
const LOCAL_SCOPE = 3;

/**
Variable object returned by -var-create Command

https://sourceware.org/gdb/current/onlinedocs/gdb/GDB_002fMI-Variable-Objects.html#GDB_002fMI-Variable-Objects
*/
export class Variable implements DebugProtocol.Variable {
	/** 
	The variable's name.  
	*/
	varName: string;
	/** 
	The variable's display name in UI.  
	*/
	name: string;
	/** 
	The variable's value. 
	*/
	value: string;
	/**
	The type of the variable's value. 
	Typically shown in the UI when hovering over the value. 
	*/
	type: string;
	/**
	If a variable object is bound to a specific thread, then this is the thread’s 
	global identifier.
	*/
	threadId: number;
	/**
	For a dynamic varobj, this indicates whether there appear to be any children 
	available. For a non-dynamic varobj, this will be 0.
	*/
	hasMore: number;
	/**
	This attribute will be present and have the value ‘1’ if the varobj is a 
	dynamic varobj. If the varobj is not a dynamic varobj, then this attribute 
	will not be present.
	*/
	dynamic: number;
	/** 
	If variablesReference is > 0, the variable is structured and its children can 
	be retrieved by passing variablesReference to the VariablesRequest. 
	*/
	variablesReference: number;
	/** 
	Properties of a variable that can be used to determine how to render the 
	variable in the UI. 
	*/
	presentationHint?: DebugProtocol.VariablePresentationHint;
	/** 
	Optional evaluatable name of this variable which can be passed to the 
	'EvaluateRequest' to fetch the variable's value. 
	*/
	evaluateName: string;

	format: string = 'natural';

	public constructor
		(varName: string, name: string, value: string, type: string) {
		this.varName = varName;
		this.name = name;
		this.putValue(value);
		this.type = type;
		this.variablesReference = 0;
		this.evaluateName =
			varName.replace(/.public|.private|.protected|.[0-9]*_anonymous/g, '');
	}

	putValue(value: string) {
		if (value) {
			value = value.replace(/\\\"/g, '\"');
			value = value.replace(/\\\'/g, '\'');
			value = value.replace(/\\\\/g, '\\');
			if (value[0] == '0' && value[1] == 'x') {
				let i = value.indexOf(' ');
				if (i > 0) {
					value = '0x' + value.substring(2, i).toUpperCase() + value.substring(i);
				}
				else {
					value = '0x' + value.substring(2).toUpperCase();
				}
			}
		}
		if (this.format == 'binary') {
			value = '0b' + value;
		}
		this.value = value;
	}

	change(record: gdbMI.MIresult) {
		let value = record['value'];
		if (value) {
			value = value.replace(/\\\"/g, '\"');
			value = value.replace(/\\\'/g, '\'');
			value = value.replace(/\\\\/g, '\\');
		}
		this.value = value;
		this.type = record['type'];
		this.threadId = record['thread-id'];
		this.hasMore = record['has_more'];
		this.dynamic = record['dynamic'];
		this.presentationHint =
			{
				kind: record['displayhint']
			};
	}

}

/**
GDB uses a breakpoint number to identify unique breakpoints.

*/
export interface GnuBreakpoint {
	/// Unique breakpoint number
	number: number;
	/// This breakpoint is verified in the current loaded firmware.
	verified: boolean;
}

class ErrorBreakpoint extends Breakpoint implements GnuBreakpoint {
	/// Unique breakpoint number
	number: number = 0;

	constructor(verified: boolean, line?: number, column?: number, source?: Source) {
		super(verified, line, column, source);
	}
}

/**
The schema for these attributes lives in the package.json of the gnu-debugger
extension. The interface should always match this schema.
*/
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/// Path to firmware to debug.
	program: string;

	/// Path Arm toolchain.
	toolchain: string;
	/// Name of GDB client.
	client: string;
	/// Arguments for GDB client.
	clientArgs: string[];
	/// Commands for GDB MI.
	gdbCommands: string[];

	/// Path to GDB server.
	server: string;
	/// Arguments for GDB server.
	serverArgs: string[];
	/// Path to GDB server.
	serverHost: string;
	/// TCP/IP server address.
	serverPort: number;
	/// Server stdout buffer

	/// List with custom variables.
	customVariables: string[];
	// Automatically run firmware. 
	autoRun: boolean;
	// Debug information output. 
	debugOutput: boolean;
}

export class GnuDebugSession extends DebugSession {
	private debugOutput: boolean = false;
	/// Starting client / server
	private starting: boolean;
	/// Program stopped
	private halt: boolean;

	/// Server
	private server: any;
	/// Server stdout buffer
	private serverBuffer: string = '';
	/// Server promise resolve
	private serverResolve: () => void;
	/// Server promise reject
	private serverReject: (error: string) => void;
	/// Test for server success
	private serverSuccess0: RegExp;
	/// Test for server success
	private serverSuccess1: RegExp;
	/// Test for server failure 
	private serverFailure: RegExp;

	/// Client
	private client: any;
	/// Client stdout buffer
	private clientBuffer: string = '';
	/// Client promise resolve
	private clientResolve: () => void;
	/// Client promise reject
	private clientReject: (error: string) => void;
	/// Test for client success
	private clientSuccess: RegExp;
	/// Test for client failure 
	private clientFailure: RegExp;

	private token: number = 1;
	private threadId: number = 1;

	private handlers: { [index: number]: (record: gdbMI.MIresult) => any } = {};

	private breakpointMap: Map<string, GnuBreakpoint[]> = new Map();

	private progress: vscode.Progress<any>;

	// Registers
	private registers: Variable[] = [];
	// Registers
	private customs: Variable[] = [];
	// Variables
	private variables: Variable[] = [];
	// Registers
	//private globals: Variable[] = [];
	// Map name to variable
	private nameToVariable: { [varName: string]: Variable } = {};
	// Map id to variable
	private referenceToVariable: { [reference: number]: Variable } = {};
	// Unique variable reference
	private variablesReference: number = LOCAL_SCOPE + 1;
	private customVariables: string[] = [];

	private autoRun: boolean = false;
	/**
	Creates a new debug adapter that is used for one debug session.
	We configure the default implementation of a debug adapter here.
	*/
	public constructor() {
		super();
		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);
	}

	/**
	The 'initialize' request is the first request called by the frontend to 
	interrogate the features the debug adapter provides.
	*/
	protected initializeRequest
		(
		response: DebugProtocol.InitializeResponse,
		args: DebugProtocol.InitializeRequestArguments
		): void {

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// Display information about variables on hover.
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsSetVariable = true;

		this.sendResponse(response);
	}

	/**
	Called at the end of the configuration sequence. Indicates that all 
	breakpoints etc. have been sent to the DA and that the 'launch' can start.
	*/
	protected configurationDoneRequest
		(
		response: DebugProtocol.ConfigurationDoneResponse,
		args: DebugProtocol.ConfigurationDoneArguments
		): void {
		super.configurationDoneRequest(response, args);
	}

	protected async launchRequest
		(
		response: DebugProtocol.LaunchResponse,
		args: LaunchRequestArguments
		) {
		let home = os.homedir();

		// default values
		if (args.toolchain) {
			args.toolchain = args.toolchain.replace('${env:HOME}', home);
			args.toolchain = args.toolchain.replace('${env:USERPROFILE}', home);
			args.toolchain = args.toolchain.replace(/\\/g, '/');
		}
		if (!args.client) {
			args.client = 'arm-none-eabi-gdb';
		}
		if (args.toolchain) {
			if (args.client.indexOf('/') < 0) {
				args.client = args.toolchain + '/' + args.client;
			}
		}
		args.client = args.client.replace(/\\/g, '/');
		if (!args.clientArgs) {
			args.clientArgs = [];
		}
		args.program = args.program.replace(/\\/g, '/');
		args.clientArgs.push('-se');
		args.clientArgs.push(args.program);
		args.clientArgs.push('-q');
		args.clientArgs.push('--interpreter=mi');
		if (!args.gdbCommands) {
			args.gdbCommands = 
			[
			//  `-gdb-version`,
			`-gdb-set target-async on`,
			`-enable-pretty-printing`,
			`-target-select extended-remote ${args.serverHost}:${args.serverPort}`,
			`-file-exec-and-symbols "${args.program}"`,
			`-interpreter-exec console "monitor halt"`,
			`-interpreter-exec console "monitor reset"`,
			`-target-download`,
			];
		}

		
		if (!args.server) {
			args.server = 'JLinkGDBServer';
		}
		args.server = args.server.replace(/\\/g, '/');
		if (!args.serverHost) {
			args.serverHost = '';
		}
		if (!args.serverPort) {
			args.serverPort = 2331;
		}
		if (args.customVariables) {
			this.customVariables = args.customVariables;
		}
		if (args.autoRun) {
			this.autoRun = args.autoRun;
		}
		if (args.debugOutput) {
			this.debugOutput = args.debugOutput;
		}

		this.stdout('program          = ' + args.program + '\n');
		this.stdout('Toolchain        = ' + args.toolchain + '\n');
		this.stdout('Client           = ' + args.client + '\n');
		this.stdout('Server           = ' + args.server + '\n');
		this.stdout('Server host      = ' + args.serverHost + '\n');
		this.stdout('Server port      = ' + args.serverPort + '\n');

		this.serverSuccess0 = /Connected to target/;
		this.serverSuccess1 = /Info : Listening/;
		this.serverFailure = /Error:|ERROR:/;
		this.clientSuccess = /\(gdb\)/;
		this.clientFailure = /Error:|ERROR:/;

		this.halt = false;
		this.starting = true;


		vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "GNU debugger "
		}, (progress) => {
				this.progress = progress;

				progress.report({ increment: 0 });

				// Try to launch the server 
				var promise = this.serverLaunch(args.server, args.serverArgs);

				progress.report({ increment: 1, message: 'Launch GDB server...' });
				promise.then
					(
					// Server success
					() => {
						this.stdout('Server success\n');
						progress.report({ increment: 2, message: 'Launch GDB client...' });

						this.clientLaunch(args.client, args.clientArgs).then
							(
							// Client success
							() => {
								this.stdout('Client success\n');
								this.starting = false;
								this.launchCommands(args.gdbCommands);
								this.sendResponse(response);
							},
							// Client failure
							(error) => {
								this.sendErrorResponse(response, 0, error);
								this.sendEvent(new TerminatedEvent());
							}
							)
					},
					// Server failure
					(error) => {
						this.sendErrorResponse(response, 0, error);
						this.sendEvent(new TerminatedEvent());
					}
					);
				return promise;
			});
	}


	protected serverLaunch
		(
		path: string,
		args: string[]
		): Promise<any> {
		return new Promise
			((resolve, reject) => {
				this.serverResolve = resolve;
				this.serverReject = reject;
				this.server = spawn(path, args);
				this.server.stdout.on('data', this.serverOutput.bind(this));
				this.server.stderr.on('data', this.serverOutput.bind(this));
				this.server.on("error", this.serverError.bind(this));
			});
	}

	/**
	Standard output of the GDB server is bound to this function.
	*/
	private serverOutput(data) {
		const text = data.toString('utf8');
		this.serverBuffer += text;

		let end = this.serverBuffer.lastIndexOf('\n');
		if (end !== -1) {
			let lines = this.serverBuffer.substr(0, end).split(/\r\n|\r|\n/) as string[];
			this.serverBuffer = this.serverBuffer.substring(end + 1);

			for (let line of lines) {
				// Display in vscode debug console
				this.debugServer(line + '\n');
				if (this.starting) {
					if 
					(
						line.match(this.serverSuccess0) || 
						line.match(this.serverSuccess1)
					) {
						this.serverResolve();
					}
					if ((line.match(this.serverFailure))) {
						this.serverReject(line);
					}
				}
			}
			if 
			(
				this.starting && 
				(
					this.serverBuffer.match(this.serverSuccess0) ||
					this.serverBuffer.match(this.serverSuccess1) 
				)
			) {
				// Display in vscode debug console
				this.debugServer(this.serverBuffer + '\n');
				this.serverBuffer = '';
				this.serverResolve();
			}
		}
	}

	/**
	Standard error of the GDB server is bound to this function.
	*/
	private serverError(data) {
		var text = data.toString('utf8');

		// Display in vscode debug console
		this.error(text);
		// this.serverReject(text);
	}

	protected clientLaunch
		(
		path: string,
		args: string[]
		): Promise<any> {
		return new Promise
			((resolve, reject) => {
				this.clientResolve = resolve;
				this.clientReject = reject;
				this.client = spawn(path, args);
				this.client.stdout.on('data', this.clientOutput.bind(this));
				this.client.stderr.on('data', this.clientError.bind(this));
				this.client.on('error', this.clientError.bind(this));
			});
	}

	/**
		Standard output of the GDB client is bound to this function.
	**/
	private clientOutput(data) {
		const text = data.toString('utf8');
		this.clientBuffer += text;

		let end = this.clientBuffer.lastIndexOf('\n');
		if (end !== -1) {
			let lines = this.clientBuffer.substr(0, end).split('\n') as string[];
			this.clientBuffer = this.clientBuffer.substring(end + 1);

			for (let line of lines) {
				this.debugClient(line + '\n');
				// Display in vscode debug console
				if (this.starting) {
					if ((line.match(this.clientSuccess))) {
						this.clientResolve();
					}
					if ((line.match(this.clientFailure))) {
						this.clientReject(text);
					}
				}
				else {
					const record = gdbMI.parseMI(line);

					if ((line.match(this.clientFailure))) {
						this.clientError(text);
					}
					if (record instanceof gdbMI.MIasync) {
						switch (record.type) {
							// exec-async-output
							case 'exec':
								let threadId: number = parseInt(record['thread-id']);
								switch (record.class) {
									case 'stopped':
										let reason = record['reason'];

										switch (reason) {
											case 'end-stepping-range':
												reason = 'step';
												break;
											case 'breakpoint-hit':
												reason = 'breakpoint';
												break;
											case 'function-finished':
												reason = 'step out';
												break;
											case 'signal-received':
												reason = 'user request';
												break;
										}
										this.stopped(reason, threadId);
										break;
									case 'running':
										this.running(threadId);
										break;
								}
								break;

							// status-async-output
							case 'status':
								switch (record.class) {
									case 'download':
										let total_size = parseInt(record['total-size']);
										let total_sent = parseInt(record['total-sent']);
										let progress = this.progress;
										if (progress && total_size & total_sent) {
											let increment = (total_sent * 100) / total_size;
											progress.report({ increment: increment, message: `Download ${total_sent} of ${total_size}` });
										}
										break;
								}
								break;

							// notify-async-output
							case 'notify':
								break;
						}
					}
					if (record instanceof gdbMI.MIstream) {
						let type = record['type'];
						let content = record['content'];
						content = content.replace(/\\\"/g, '\"');
						content = content.replace(/\\\'/g, '\'');
						content = content.replace(/\\\\/g, '\\');
						content = content.replace(/\\n/g, '\n');
						content = content.replace(/\\r/g, '\r');
						content = content.replace(/\\t/g, '\t');
						content = content.replace(/\\v/g, '\v');

						this.sendEvent(new OutputEvent(content, type));
					}
					if (record instanceof gdbMI.MIresult) {
						if (record.token != NaN) {
							const handler = this.handlers[record.token];

							if (handler) {
								handler(record);
								delete this.handlers[record.token];
							}
						}
					}
				}
			}
			if (this.starting && this.clientBuffer.match(this.clientSuccess)) {
				// Display in vscode debug console
				this.debugClient(this.clientBuffer + '\n');
				this.clientBuffer = '';
				this.clientResolve();
			}
		}
	}

	/**
	Standard error of the GDB client is bound to this function.
	*/
	private clientError(data) {
		var text = data.toString('utf8');

		// Display in vscode debug console
		this.error(text);
		this.clientReject(text);
	}

	protected setBreakPointsRequest
		(
		response: DebugProtocol.SetBreakpointsResponse,
		args: DebugProtocol.SetBreakpointsArguments
		): void {
		this.debugServer('setBreakPointsRequest\n');
		let filename = args.source.path;
		if (filename) {
			filename = filename.replace(/\\/g, '/');
			// Get the current breakpoint list
			let breakpointMap = (this.breakpointMap.get(filename) || []);
			let numbers = breakpointMap.map((breakpoint) => breakpoint.number);
			let promises: Promise<any>[] = [];

			if (numbers.length) {
				for (let bp of breakpointMap) {
					bp.verified = false;
				}
				// Clear all previous breakpoints.
				let command = '-break-delete ' + numbers.join(' ');

				let promise = this.sendCommand(command);
				promises.push(promise);

				promise.then
					((record: gdbMI.MIresult) => {
						this.debugServer('breakpoints delete done ');
					});

			}

			let breakpoints = args.breakpoints;
			let verifiedBreakpoints: GnuBreakpoint[] = [];

			if (breakpoints) {
				breakpoints.forEach((b) => {
					let command = `-break-insert "${filename}:${b.line}"`;

					let promise = this.sendCommand(command);
					promises.push(promise);

					promise.then
						((record: gdbMI.MIresult) => {
							let breakpoint = record['bkpt'];

							breakpoint.verified = true;

							verifiedBreakpoints.push(breakpoint);
						});
				});

				Promise.all(promises).then
					(() => {
						this.debugServer('breakpoints insert done ');
						if (filename) {
							this.breakpointMap.set(filename, verifiedBreakpoints);
						}
						response.body =
							{
								breakpoints: verifiedBreakpoints
							};
						this.sendResponse(response);
					},
					() => {
						verifiedBreakpoints = [];
						if (breakpoints) {
							for (let b of breakpoints) {
								let breakpoint = new ErrorBreakpoint(false, b.line, b.column);

								verifiedBreakpoints.push(breakpoint);
							}
						}
						response.body =
							{
								breakpoints: verifiedBreakpoints
							};
						this.sendResponse(response);
					});
			}
		}
	}

	protected threadsRequest
		(
		response: DebugProtocol.ThreadsResponse
		): void {
		this.debugServer('threadsRequest\n');
		if (!this.halt) {
			response.body =
				{
					threads:
						[
							new Thread(this.threadId, "thread " + this.threadId)
						]
				};
			this.sendResponse(response);
		}
		else {
			this.sendCommand('-thread-list-ids').then
				((record: gdbMI.MIresult) => {
					const threads: Thread[] = [];
					try {
						const threadIds = record['thread-ids'];
						this.threadId = record['current-thread-id'];

						for (let name in threadIds) {
							let value: number = parseInt(threadIds[name]);
							threads.push(new Thread(value, name));
						}
					}
					catch (e) { }
					response.body =
						{
							threads: threads
						};
					this.sendResponse(response);
				});
		}
	}

	protected stackTraceRequest
		(
		response: DebugProtocol.StackTraceResponse,
		args: DebugProtocol.StackTraceArguments
		): void {
		this.debugServer('stackTraceRequest\n');
		this.sendCommand
			(`-stack-list-frames --thread ${args.threadId} ${args.startFrame} ${args.levels}`).then
			((record: gdbMI.MIresult) => {
				let stackFrames: StackFrame[] = [];

				try {
					let stack = record['stack'];
					let length = stack.length;

					for (let i = 0; i < length; i++) {
						let frame = stack[i].value;
						let level: number = parseInt(frame.level);
						let addr: string = frame.addr.toUpperCase().replace('X', 'x');
						let func: string = frame.func;
						let file: string = frame.file;
						let fullname: string = frame.fullname;
						let line: number = parseInt(frame.line);
						let source = new Source(file, fullname);
						let stackFrame;

						// Prevent undefined message when there is no source file.
						// vscode will now show Unknown Source in the UI
						if (file == undefined)
						{
							stackFrame = 
							new StackFrame(level, func + ' @ ' + addr);
						}
						else
						{
							stackFrame = 
							new StackFrame(level, func + ' @ ' + addr, source, line, 0);
						}
						stackFrames.push(stackFrame);
					}
				}
				catch (e) { }
				response.body =
					{
						stackFrames: stackFrames,
						totalFrames: stackFrames.length,
					};
				this.sendResponse(response);
			});
	}

	protected scopesRequest
		(
		response: DebugProtocol.ScopesResponse,
		args: DebugProtocol.ScopesArguments
		): void {
		this.debugServer('scopesRequest\n');
		let scopes: Scope[] = [];

		scopes.push(new Scope("REGISTER", REGISTER_SCOPE, true));
		if (this.customVariables && this.customVariables.length > 0) {
			scopes.push(new Scope("CUSTOM", CUSTOM_SCOPE, true));
		}
		scopes.push(new Scope("LOCAL", LOCAL_SCOPE, true));
		response.body =
			{
				scopes: scopes,
			};
		this.sendResponse(response);
		if (this.stopped && this.autoRun) {
			this.autoRun = false;
			this.sendCommand('-exec-continue');
		}
	}

	protected variablesRequest
		(
		response: DebugProtocol.VariablesResponse,
		args: DebugProtocol.VariablesArguments
		): void {
		this.debugServer('variablesRequest\n');

		const variablesReference: number = args.variablesReference;

		switch (variablesReference) {
			case REGISTER_SCOPE:
				{
					if (this.registers.length == 0) {
						// Create a need a list with register names.
						this.sendCommand('-data-list-register-names').then
							((record: gdbMI.MIresult) => {
								let names = record['register-names'];
								let promises: Promise<any>[] = [];

								for (let name of names) {
									if (name) {
										let varName = 'register:' + name.toUpperCase();
										let expression = '$' + name;
										let promise =
											this.sendCommand(`-var-create ${varName} @ ${expression}`);
										promise.then
											((record: gdbMI.MIresult) => {
												name = name.toUpperCase();
												let value = record['value'];
												let variable = new Variable(varName, name, value, "");
												variable.evaluateName = expression;
												this.registers.push(variable);
												this.nameToVariable[varName] = variable;
											});
										promises.push(promise);
									}
								}
								Promise.all(promises).then
									(() => {
										response.body =
											{
												variables: this.registers,
											};
										this.sendResponse(response);
									},
									() => {
										response.body =
											{
												variables: this.registers,
											};
										this.sendResponse(response);
									});
							});
					}
					else {
						this.variableUpdate().then(
							() => {
								response.body =
									{
										variables: this.registers,
									};
								this.sendResponse(response);
							}
						);
					}
				}
				break;
			case CUSTOM_SCOPE:
				{
					let promises: Promise<any>[] = [];
					if (this.customs.length == 0) {
						let names = this.customVariables;

						for (let name of names) {
							let expression = name;
							let promise =
								this.variableCreate(name, expression, this.customs);
							promises.push(promise);
						}
					}
					promises.push(this.variableUpdate());
					Promise.all(promises).then
						(() => {
							response.body =
								{
									variables: this.customs,
								};
							this.sendResponse(response);
						},
						() => {
							response.body =
								{
									variables: this.customs,
								};
							this.sendResponse(response);
						});
				}
				break;
			case LOCAL_SCOPE:
				{
					this.sendCommand
						('-stack-list-variables --no-values').then
						((record: gdbMI.MIresult) => {
							let list = record['variables'];
							let promises: Promise<any>[] = [];
							this.variables = [];

							for (let v of list) {
								let expression = v.name;
								let name = expression;

								let variable = this.nameToVariable[name];

								if (variable) {
									this.variables.push(variable);
								}
								else {
									let promise =
										this.variableCreate(name, expression, this.variables);
									promises.push(promise);
								}
							}
							promises.push(this.variableUpdate());

							Promise.all(promises).then(() => {
								response.body =
									{
										variables: this.variables,
									};
								this.sendResponse(response);
							});
						});
				}
				break;
			default:
				{
					let promises: Promise<any>[] = [];
					let variables: Variable[] = [];
					let variable = this.referenceToVariable[variablesReference];

					if (variable) {
						let promise = this.createChildren(variable.varName, variables);
						promises.push(promise);
					}
					Promise.all(promises).then
						(() => {
							response.body =
								{
									variables: variables,
								};
							this.sendResponse(response);
						},
						() => {
							response.body =
								{
									variables: variables,
								};
							this.sendResponse(response);
						});
				}
				break;
		}
	}

	protected setVariableRequest
		(
		response: DebugProtocol.SetVariableResponse,
		args: DebugProtocol.SetVariableArguments
		): void {
		this.debugServer('setVariableRequest\n');
		let parent = this.referenceToVariable[args.variablesReference];
		let expression = args.value;
		let varName;

		if (parent) {
			varName = parent.evaluateName + '.' + args.name;
		}
		else {
			varName = args.name;
		}
		let variable = this.nameToVariable[varName];
		if (!variable) {
			varName = 'register:' + varName;
			variable = this.nameToVariable[varName];
		}
		if (variable) {
			let promises: Promise<any>[] = [];

			varName = variable.varName;
			if (expression[0] == '0') {
				let format: string = '';

				switch (expression[1]) {
					case 'b':
						format = 'binary';
						if (expression.length == 2) {
							expression = '';
						}
						break;
					case 'o':
						format = 'octal';
						if (expression.length > 2) {
							expression = '0' + expression.substring(2);
						}
						else {
							expression = '';
						}
						break;
					case 'd':
						format = 'decimal';
						if (expression.length > 2) {
							expression = expression.substring(2);
						}
						else {
							expression = '';
						}
						break;
					case 'x':
						format = 'hexadecimal';
						if (expression.length == 2) {
							expression = '';
						}
						break;
					case 'n':
						format = 'natural';
						expression = '';
						break;
					default:
						if (expression[1] >= '0' && expression[1] <= '7') {
							format = 'octal';
						}
						break;
				}
				if (format) {
					let promise = this.variableSetFormat(varName, format);
					promises.push(promise);
				}
			}
			if (expression != '') {
				let promise = this.variableAssign(varName, expression);
				promises.push(promise);
			}
			Promise.all(promises).then
				(() => {
					response.body =
						{
							value: variable.value
						}
					this.sendResponse(response);
				},
				() => {
					this.sendResponse(response);
				});

		}
		else {
			this.sendResponse(response);
		}
	}

	protected createChildren
		(
		/// GDB variable name
		name: string,
		/// Variables
		variables: Variable[]
		): Promise<any> {
		this.debugServer('createChildren ' + name + '\n');
		return new Promise((resolve, reject) => {
			let promise =
				this.sendCommand(`-var-list-children --simple-values "${name}"`);
			promise.then
				((record: gdbMI.MIresult) => {
					let promises: Promise<any>[] = [];

					let children = record['children'];

					for (let c of children) {
						let child = c.value;
						let name = child.exp;

						switch (name) {
							case 'public':
							case 'private':
							case 'protected':
							case '<anonymous union>':
							case '<anonymous struct>':
								{
									let promise = this.createChildren(child.name, variables);
									promises.push(promise);
								}
								break;

							default:

								if (child.type && child.type[0] != '_') {
									let value = child.value;
									if (!value) {
										if (child.type) {
											const i = child.type.indexOf('[');
											if (i > 0) {
												value = child.type.substring(i);
											}
										}
									}

									let variable = new Variable(child.name, name, value, child.type);
									variables.push(variable);
									this.nameToVariable[child.name] = variable;
									this.nameToVariable[variable.evaluateName] = variable;

									let numchild: number = parseInt(child.numchild);
									if (numchild > 0) {
										let reference = this.variablesReference++;
										variable.variablesReference = reference;
										this.referenceToVariable[reference] = variable;
									}
									break;
								}
						}
					}
					Promise.all(promises).then
						(() => {
							resolve();
						},
						() => {
							reject();
						});
				});
		});
	}

	/**
	Create a GDB variable
	*/
	protected variableCreate
		(
		/// Name of the variable
		name: string,
		/// Expression to evaluate to get value of variable 
		expression: string,
		/// List with variables
		variables: Variable[],
	): Promise<any> {
		return this.sendCommand(`-var-create "${name}" @ "${expression}"`).then
			((record: gdbMI.MIresult) => {
				let varName = record['name'];
				let value = record['value'];
				let type = record['type'];
				let numchild: number = parseInt(record['numchild']);

				let variable = new Variable(varName, varName, value, type);

				if (numchild > 0) {
					let reference = this.variablesReference++;
					variable.variablesReference = reference;
					this.referenceToVariable[reference] = variable;
				}
				variables.push(variable);
				this.nameToVariable[varName] = variable;
			});
	}

	/**
	Assign a GDB variable
	*/
	protected variableAssign
		(
		/// Name of the variable
		name: string,
		/// Expression to evaluate to assign value of variable 
		expression: string
		): Promise<any> {
		return this.sendCommand(`-var-assign "${name}" "${expression}"`).then
			((record: gdbMI.MIresult) => {
				let variable = this.nameToVariable[name];
				if (variable) {
					variable.putValue(record['value']);
				}
			});
	}

  /**
	Set format of a GDB variable
	*/
	protected variableSetFormat
		(
		/// Name of the variable
		name: string,
		/// Format of variable 
		format: string
		): Promise<any> {
		return this.sendCommand(`-var-set-format "${name}" ${format}`).then
			((record: gdbMI.MIresult) => {
				let variable = this.nameToVariable[name];
				if (variable) {
					variable.format = record['format'];
					variable.putValue(record['value']);
				}
			});
	}

	/**
	Update GDB variables
	*/
	protected variableUpdate(): Promise<any> {
		let promise = this.sendCommand('-var-update --all-values *');
		promise.then
			((record: gdbMI.MIresult) => {
				let changelist = record['changelist'];

				for (let change of changelist) {
					let variable = this.nameToVariable[change.name];

					if (variable) {
						variable.putValue(change.value);
					}
				}
			});
		return promise;
	}


	protected continueRequest
		(
		response: DebugProtocol.ContinueResponse,
		args: DebugProtocol.ContinueArguments
		): void {
		this.debugServer('continueRequest\n');
		this.sendCommand(`-exec-continue --thread ${this.threadId}`).then
			((record: gdbMI.MIresult) => {
				this.sendResponse(response);
			});
	}

	protected pauseRequest
		(
		response: DebugProtocol.PauseResponse,
		args: DebugProtocol.PauseArguments
		): void {
		this.debugServer('pauseRequest\n');
		this.sendCommand(`-exec-interrupt --thread ${this.threadId}`).then
			((record: gdbMI.MIresult) => {
				this.sendResponse(response);
			});
	}

	protected nextRequest
		(
		response: DebugProtocol.NextResponse,
		args: DebugProtocol.NextArguments
		): void {
		this.debugServer('nextRequest\n');
		this.sendCommand(`-exec-next --thread ${this.threadId}`).then
			((record: gdbMI.MIresult) => {
				this.sendResponse(response);
			});
	}

	protected stepInRequest
		(
		response: DebugProtocol.StepInResponse,
		args: DebugProtocol.StepInArguments
		): void {
		this.debugServer('stepInRequest\n');
		this.sendCommand(`-exec-step --thread ${this.threadId}`).then
			((record: gdbMI.MIresult) => {
				this.sendResponse(response);
			});
	}

	protected stepOutRequest
		(
		response: DebugProtocol.StepOutResponse,
		args: DebugProtocol.StepOutArguments
		): void {
		this.debugServer('stepOutRequest\n');
		this.sendCommand(`-exec-finish --thread ${this.threadId}`).then
			((record: gdbMI.MIresult) => {
				this.sendResponse(response);
			});
	}

	protected restartRequest
		(
		response: DebugProtocol.RestartResponse,
		args: DebugProtocol.RestartArguments
		): void {
		this.debugServer('restartRequest\n');
		this.sendCommand('-exec-run').then
			((record: gdbMI.MIresult) => {
				this.sendResponse(response);
			});
	}

	protected disconnectRequest
		(
		response: DebugProtocol.DisconnectResponse,
		args: DebugProtocol.DisconnectArguments
		): void {
		this.debugServer('disconnectRequest\n');
		this.debugServer('Client kill\n');
		// Kill the client
		try { this.client.kill(); } catch (error) { }
		this.debugServer('Server kill\n');
		// Kill the server 
		try { this.server.kill(); } catch (error) { }

		this.sendResponse(response);
	}

	protected evaluateRequest
		(
		response: DebugProtocol.EvaluateResponse,
		args: DebugProtocol.EvaluateArguments
		): void {
		this.debugServer('evaluateRequest\n');

		switch (args.context) {
			// User typed a GDB command in the console
			case 'repl':
				this.sendCommand(args.expression).then
					((record: gdbMI.MIresult) => {
						this.sendResponse(response);
					},
					() => {
						this.sendResponse(response);
					});
				break;

			// User request information about a variable.
			case 'hover':
				this.sendCommand(`-data-evaluate-expression "${args.expression}"`).then
					((record: gdbMI.MIresult) => {
						response.body =
							{
								result: record['value'],
								variablesReference: 0
							};
						this.sendResponse(response);
					},
					() => {
						this.sendResponse(response);
					});
				break;

			case 'watch':
				let expression = args.expression;
				let name = "watch:" + expression;
				let variable = this.nameToVariable[name];

				if (variable) {
					this.variableUpdate().then
						(() => {
							response.body =
								{
									result: variable.value,
									variablesReference: variable.variablesReference
								};
							this.sendResponse(response);
						},
						() => {
							this.sendResponse(response);
						});
				}
				else {
					this.variableCreate(name, expression, this.variables).then
						(() => {
							let variable = this.nameToVariable[name];
							response.body =
								{
									result: variable.value,
									variablesReference: variable.variablesReference
								};
							this.sendResponse(response);
						},
						() => {
							response.body =
								{
									result: '',
									variablesReference: 0
								};
							this.sendResponse(response);
						});
				}
				break;

			default:
				this.sendResponse(response);
				break;
		}
	}

	protected customRequest
		(
		command: string,
		response: DebugProtocol.Response,
		args: any
		): void {
		this.debugServer('customRequest\n');
	}

	private launchCommands(commands: string[]) {
		const promises = commands.map((c) => this.sendCommand(c));

		Promise.all(promises).then(() => {
			this.debugServer('launchCommands send \n');
			this.stopped('start', this.threadId);
			// We are ready to set breakpoints. 
			this.sendEvent(new InitializedEvent());
		});
	}

	private sendCommand(command: string): Promise<any> {
		// Every command gets an unique token
		const token = this.token++;

		command = token + command + '\n'
		this.debugServer(command);

		return new Promise((resolve, reject) => {
			this.handlers[token] = (record: gdbMI.MIresult) => {
				if (record.class == 'error') {
					this.error(`ERROR: ${record['msg']}\n`);
					reject(record);
				}
				else {
					resolve(record);
				}
			};
			this.client.stdin.write(command);
		});
	}

	private debugClient(text: string) {
		if (this.debugOutput) {
			this.sendEvent(new OutputEvent(text, 'stdout'));
		}
	}

	private debugServer(text: string) {
		if (this.debugOutput) {
			this.sendEvent(new OutputEvent(text, 'console'));
		}
	}

	private stdout(text: string) {
		this.sendEvent(new OutputEvent(text, 'stdout'));
	}

	private error(text: string) {
		this.sendEvent(new OutputEvent(text, 'stderr'));
	}

	private stopped(reason: string, threadId: number) {
		this.halt = true;
		this.sendEvent(new StoppedEvent(reason, threadId));
	}

	private running(threadId: number) {
		this.halt = false;
		this.sendEvent(new ContinuedEvent(threadId));
	}
}

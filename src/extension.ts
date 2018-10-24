/**
extension.ts

GNU source level debugger.

The GnuConfigurationProvider is used to set the default values of the debug
configuration in launch.json.

@file
@copyright   Atomclip, all rights reserved
@author      Carl van Heezik
@version     0.0.3
@since       2018-06-29
*/
'use strict';

import * as vscode from 'vscode';
import 
{
	WorkspaceFolder, DebugConfiguration, ProviderResult, CancellationToken
} from 'vscode';
import * as Net from 'net';
import 
{
	GnuDebugSession
} from './session';


/*
Set the following compile time flag to true if the debug adapter should run 
inside the extension host.
 
Please note: the test suite does no longer work in this mode.
*/
const EMBED_DEBUG_ADAPTER = true;

export class GnuExtension 
{
	constructor(context: vscode.ExtensionContext)
	{
		// register a configuration provider for 'gnu-debugger' 
		const provider = new GnuConfigurationProvider()

		context.subscriptions.push
			(
			vscode.debug.registerDebugConfigurationProvider
				('gnu-debugger', provider)

			);
	}
}

class GnuConfigurationProvider implements vscode.DebugConfigurationProvider
{
	private server?: Net.Server;

	/**
	Massage a debug configuration just before a debug session is being launched,
	e.g. add all missing attributes to the debug configuration.
	*/
	resolveDebugConfiguration
		(
		folder: WorkspaceFolder | undefined,
		config: DebugConfiguration,
		token?: CancellationToken
		): ProviderResult<DebugConfiguration>
	{
		// We like to debug our debug adapter  
		if (EMBED_DEBUG_ADAPTER)
		{
			// start port listener on launch of first debug session
			if (!this.server)
			{
				// start listening on a random port
				this.server = Net.createServer(socket =>
				{
					const session = new GnuDebugSession();
					session.setRunAsServer(true);
					session.start(<NodeJS.ReadableStream>socket, socket);
				}).listen(0);
			}

			// make VS Code connect to debug server instead of launching debug adapter
			let address = this.server.address() as Net.AddressInfo;
			if (address)
			{
				config.debugServer = address.port;
			}
		}
		return config;
	}

	dispose()
	{
		if (this.server)
		{
			this.server.close();
		}
	}
	
}


export function activate(context: vscode.ExtensionContext)
{
	const extension = new GnuExtension(context);

	if (extension) { }
}

export function deactivate()
{
	// nothing to do
}


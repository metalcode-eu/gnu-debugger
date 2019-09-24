# GNU source level debugger for Visual Studio Code

This extension for Visual Studo Code enables debugging of bare metal C/C++ 
programs for Arm Cortex processors. The extension implements the Visual Studio
Code debug adaptor for Arm embedded processors. This extension is suited for
macOS, Linux and Window. 

<div align="center">
<img src="https://raw.githubusercontent.com/metalcode-eu/gnu-debugger/master/images/GNU-debugger-512x512.png" alt="GNU debugger" width="20%">
<img src="https://raw.githubusercontent.com/metalcode-eu/gnu-debugger/master/images/macOS-512x512.png" alt="macOS" width="20%">
<img src="https://raw.githubusercontent.com/metalcode-eu/gnu-debugger/master/images/Linux-512x512.png" alt="Linux" width="20%">
<img src="https://raw.githubusercontent.com/metalcode-eu/gnu-debugger/master/images/Windows-512x512.png" alt="Windows" width="20%">
</div>

The adaptor uses the GNU source level debugger (GDB) that enables examination of 
your running program. You can find background documentation about the GNU source
level debugger 
[here](https://sourceware.org/gdb/current/onlinedocs/gdb/).

# Dependencies

- GDB client from GNU toolchain for you operating system (one of the following)
  - [GNU Arm embedded toolchain for macOS](https://marketplace.visualstudio.com/items?itemName=metalcode-eu.darwin-arm-none-eabi)
  - [GNU Arm embedded toolchain for Linux (64-bit)](https://marketplace.visualstudio.com/items?itemName=metalcode-eu.linux-arm-none-eabi)
  - [GNU Arm embedded toolchain for Windows](https://marketplace.visualstudio.com/items?itemName=metalcode-eu.windows-arm-none-eabi)
- GDB server for your debug probe (one of the following)
  - [SEGGER J-Link probe](https://www.segger.com/downloads/jlink/)
  - ST-Link debug probe upgraded to J-Link probe

If you have a development board with an onboard ST-Link debug probe you can 
upgrade the firmware to J-Link. More information for upgrading to J-Link may 
be found
[here](https://www.segger.com/products/debug-probes/j-link/models/other-j-links/st-link-on-board/). 

# Features
<img src="https://raw.githubusercontent.com/metalcode-eu/gnu-debugger/master/images/play-bar.png" alt="playbar">

- source level debugging of C and C+++
- set / clear breakpoints
- pause / continue, step over, step into, step out, restart
- change variables
- watch expressions

## Output format
Visual Studio Code has no standard way to set the format of variables. In this 
extension you can change the output format with a number prefix.

<img src="https://raw.githubusercontent.com/metalcode-eu/gnu-debugger/master/images/set-format.png" alt="set format">

Use the following number prefixes:
- *0b* = binary
- *0o* = octal
- *0d* = decimal
- *0x* = hexadecimal
- *0n* = natural (back to GDB default output format)

## Custom variables
To view/change global variables on every debug session add a *customVariables*
list to the launch.json.

<div align="center">
<img src="https://raw.githubusercontent.com/metalcode-eu/gnu-debugger/master/images/custom.png" alt="custom variables">
</div>

Here is an example launch.json for the Infineon XMC 2Go a low cost board with 
an Arm Cortex-M0 processor.

<div align="center">
<img src="https://raw.githubusercontent.com/metalcode-eu/gnu-debugger/master/images/XMC2Go.jpg" alt="XMC 2Go">
</div>

```javascript
{
  // Visual Studio Code launch.json for XMC 2Go development board 
  "version": "0.2.0",
  "configurations": [
    {
      "type": "gnu-debugger",
      "request": "launch",
      "name": "GNU debugger",
      "program": "${workspaceFolder}/build.nosync/firmware.elf",
      "toolchain": "${config:arm-none-eabi.bin}",
      "client": "arm-none-eabi-gdb",
      "server": "JLinkGDBServer",
      "windows": {
        "server": "C:/Program Files/SEGGER/JLink_V632g/JLinkGDBServerCL.exe",
      },
      "serverArgs": [
        "-device", "XMC1100-0064",
        "-if", "SWD",
        "-speed", "4000"
      ],
      "serverPort": 2331,
      "customVariables": [
        "port0",
        "port1",
        "port2",
      ],
      "autoRun": false,
      "debugOutput": false,
      "preLaunchTask": "build firmware"
    }
  ]
}
```

# Principle of operation
The extension uses the machine oriented text interface of the GNU source level
debugger 
([GDB/MI](https://sourceware.org/gdb/current/onlinedocs/gdb/GDB_002fMI.html#GDB_002fMI)).
The adaptor translates workbench.action.debug commands to GDB/MI commands and
translate GDB/MI outputs to graphical representation inside Visual Studio Code.

For Arm embedded platforms the GNU source level debugger consists of two parts:
- GDB client
- GDB server

Both programs must be installed on your development system. 

### GDB client
The GDB client is supplied by Arm free of charge as part of the Arm embedded 
toolchain. For convience I have packaged the latest toolchain for different 
operating systems as Visual Studio Code extension as mentioned in the 
dependencies section.

You can find GDB client for Arm embedded processors under the bin directory of
the toolchain. The name of the GDB client program is:

- arm-none-eabi-gdb (macOS, Linux)
- arm-none-eabi-gdb.exe (Windows)

The GDB client communicates with a GDB server through a network connection 
(TCP/IP socket). 

### GDB server
The GDB server is supplied by the manufacterer of the debug probe. The most 
widely used lines of debug probes are the J-Link and ST-Link debug probes. 
The name of the SEGGER J-Link GDB server program is:

- JLinkGDBServer  (macOS, Linux) 
  (symbolic link, the actual command line program is JLinkGDBServerCLExe)
- JLinkGDBServerCL.exe (Windows)

If you have a development board with an onboard ST-Link debug probe you can 
upgrade the firmware to J-Link. More information for upgrading to J-Link may 
be found
[here](https://www.segger.com/products/debug-probes/j-link/models/other-j-links/st-link-on-board/). 

### OpenOCD
The Open On-Chip Debugger supports a large amount of debug probes. Starting 
from Version 0.0.5 you can use OpenOCD as GDB server. 

# Release Notes

### Version 0.0.7
Added gdbCommands to support PSoC 6. 

### Version 0.0.5
OpenOCD support. 

### Version 0.0.4
Some of the dependencies required an update because they contained 
vulnerabilities. Changed several devDependencies. 

### Version 0.0.3
Changes in visual studio code 1.28.1 caused a problem. Updated all vscode
dependencies to the latest version.

### Version 0.0.2
Fixed a bug causing a error message "resource is not available".
This problems shows when you have a source file compiled without debug 
information. Visual Studio code now shows "Unknown Source" if the debug
information is missing. 

### Version 0.0.1
First version tested on macOS, Linux and Windows. 

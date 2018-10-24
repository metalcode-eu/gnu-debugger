/**
parser.ts

Parse GDB/MI output.

@file
@copyright   Atomclip, all rights reserved
@author      Carl van Heezik
@version     0.0.1
@since       2018-06-29

See GNU manual for background information.
https://sourceware.org/gdb/current/onlinedocs/gdb/GDB_002fMI-Output-Syntax.html#GDB_002fMI-Output-Syntax 

output →
( out-of-band-record )* [ result-record ] "(gdb)" nl

result-record →
[ token ] "^" result-class ( "," result )* nl

out-of-band-record →
async-record | stream-record

async-record →
exec-async-output | status-async-output | notify-async-output

exec-async-output →
[ token ] "*" async-output nl

status-async-output →
[ token ] "+" async-output nl

notify-async-output →
[ token ] "=" async-output nl

async-output →
async-class ( "," result )*

result-class →
"done" | "running" | "connected" | "error" | "exit"

async-class →
"stopped" | others (where others will be added depending on the needs—this is still in development).

result →
variable "=" value

variable →
string

value →
const | tuple | list

const →
c-string

tuple →
"{}" | "{" result ( "," result )* "}"

list →
"[]" | "[" value ( "," value )* "]" | "[" result ( "," result )* "]"

stream-record →
console-stream-output | target-stream-output | log-stream-output

console-stream-output →
"~" c-string nl

target-stream-output →
"@" c-string nl

log-stream-output →
"&" c-string nl

nl →
CR | CR-LF

token →
any sequence of digits.

*/

const TOKEN = 1;
const CLASS = 2;
const ASYNC = 2;
const STREAM = 3;

const C_STRING = /^\"((\\.|[^"])*)\"/;
const OUT_OF_BAND_RECORD = /^(?:(\d*)([\*\+\=])|([\~\@\&]))/;
const ASYNC_CLASS = /^([_a-zA-Z0-9\-]*)/;
const VARIABLE = /^([a-zA-Z_][a-zA-Z0-9_\-]*)/;

const RESULT_RECORD = /^(\d*)\^(done|running|connected|error|exit)/;

const ASYNC_TYPE =
{
  '*': 'exec',
  '+': 'status',
  '=': 'notify'
};
const STREAM_TYPE =
{
  '~': 'console',
  '@': 'target',
  '&': 'log'
};

export class MIresult
{
  public token: number;
  public class: string;
}

export class MIvariable
{
  public name: string;
  public value: any;
}

export class MIasync
{
  public token: number;
  public type: string;
  public class: string;
}

export class MIstream
{
  public token: number;
  public type: string;
  public content: string;
}

export function parseMI
  (
  output: string
  ): any
{
  let record;
  let match;

  // Parse tuple value
  const tuple = () => 
  {
    let t: any = {};
    do 
    {
      output = output.substring(1);

      let r = result();

      if (r)
      {
        t[r.name] = r.value;
      }
    } while (output[0] == ',');
    if (output[0] == '}')
    {
      output = output.substring(1);
    }
    return t;
  }

  const results = () => 
  {
    let l: any = [];
    do 
    {
      output = output.substring(1);
      let r = result();

      if (r)
      {
        l.push(r);
      }
    } while (output[0] == ',');
    if (output[0] == ']')
    {
      output = output.substring(1);
    }
    return l;
  }

  // Parse a list value
  const list = () => 
  {
    let l;

    switch (output[1])
    {
      case '"':
      case '{':
      case '[':
        l = values();
        break;
      default:
        l = results();
    }
    return l;
  }

  // Parse comma separated values
  const values = () =>
  {
    let l: any = [];
    do 
    {
      output = output.substring(1);
      let v = value();

      l.push(v);
    } while (output[0] == ',');
    if (output[0] == ']')
    {
      output = output.substring(1);
    }
    return l;
  }

  // Parse a const value
  const cstring = () =>
  {
    match = C_STRING.exec(output);
    if (match)
    {
      output = output.substring(match[0].length);
      return match[1];
    }
    return "";
  }

  // Parse a value
  const value = () =>
  {
    switch (output[0])
    {
      case '"':
        return cstring();
      case '{':
        return tuple();
      case '[':
        return list();
    }
  }

  // Parse a result
  const result = () =>
  {
    let variable;

    match = VARIABLE.exec(output);
    if (match)
    {
      variable = new MIvariable;
      variable.name = match[1];
      output = output.substring(match[0].length);
      if (output[0] == '=')
      {
        output = output.substring(1);
        variable.value = value();
      }
    }
    return variable;
  }

  // Parse an out of band record
  const outOfBandRecord = () =>
  {
    if (!record)
    {
      match = OUT_OF_BAND_RECORD.exec(output);
      if (match)
      {
        output = output.substring(match[0].length);
        // async-record
        if (match[ASYNC])
        {
          record = new MIasync;
          record.token = parseInt(match[TOKEN]);
          record.type = ASYNC_TYPE[match[ASYNC]];
          match = ASYNC_CLASS.exec(output);
          if (match)
          {
            record.class = match[1];
            output = output.substring(match[0].length);
            while (output[0] == ',')
            {
              output = output.substring(1);
              if (output[0] == '{')
              {
                output = output.substring(1);
              }
              const r = result();
              if (r)
              {
                record[r.name] = r.value;
              }
            }
            if (output[0] == '}')
            {
              output = output.substring(1);
            }
          }
        }
        // stream-record
        else if (match[STREAM])
        {
          record = new MIstream;
          record.token = parseInt(match[TOKEN]);
          record.type = STREAM_TYPE[match[STREAM]];
          record.content = cstring();
        }
      }
    }
  }

  // Parse a result record 
  const resultRecord = () =>
  {
    if (!record)
    {
      match = RESULT_RECORD.exec(output);
      if (match)
      {
        // result record
        record = new MIresult;
        record.token = parseInt(match[TOKEN]);
        record.class = match[CLASS];
        output = output.substring(match[0].length);
        while (output[0] == ',')
        {
          output = output.substring(1);
          const r = result();
          if (r)
          {
            record[r.name] = r.value;
          }
        }
      }
    }
  }

  outOfBandRecord();
  resultRecord();

  return record;
}
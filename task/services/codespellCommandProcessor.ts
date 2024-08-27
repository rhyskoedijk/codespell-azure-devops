import { GitPullRequestCommentThread, Comment } from "azure-devops-node-api/interfaces/GitInterfaces";
import { IFile, IFileSuggestion } from "./types";
import { warning, error } from "azure-pipelines-task-lib/task"
import fs from "fs";
import ini from "ini";
import path from "path";

export class CodespellCommandProcessor {

  readonly configFilePath = ".codespellrc";
  readonly commandPrefix = "@codespell";

  public getCommandHelpTextFor(suggestion: IFileSuggestion): string {
    return [
      "<details>",
      "<summary>🛠️ Codespell commands and options</summary>",
      "",
      "You can trigger Codespell actions by replying to this comment with any of the following commands:",
      " - `" + this.commandPrefix + " ignore this` will ignore this single misspelling instance using an inline code comment",
      " - `" + this.commandPrefix + " ignore line` will ignore all misspellings on line " + suggestion.lineNumber + " using an inline code comment",
      " - `" + this.commandPrefix + " ignore word` will add `" + suggestion.word + "` to the global ignored words list",
      " - `" + this.commandPrefix + " ignore file` will add `" + suggestion.path + "` to the global ignored files list",
      " - `" + this.commandPrefix + " ignore file-type` will add `*." + suggestion.path.split(".").pop() + "` to the global ignored files list",
      " - `" + this.commandPrefix + " ignore dir` will add `" + suggestion.path.split(path.sep).splice(0, -1).join(path.sep) + path.sep + "*` to the global ignored files list",
      " - `" + this.commandPrefix + " ignore <pattern>` will add a custom file path pattern to the global ignored files list",
      "",
      "After commenting, re-queue your codespell pipeline to process the command change.",
      "</details>"
    ].join("\n");
  }
  
  public async processCommands(options: {
    pullRequestId: number,
    thread: GitPullRequestCommentThread,
    comment: Comment,
    suggestion: IFileSuggestion
  }) : Promise<boolean> {
    let commandsWereHandled = false;

    // If the comment doesn't have a command prefix, ignore it
    if (!options.comment.content?.startsWith(this.commandPrefix)) {
      return commandsWereHandled;
    }

    // Parse the command
    const command: string[] = options.comment.content.substr(this.commandPrefix.length).trim().split(" ").map(c => c.trim().toLocaleLowerCase());
    if (command.length === 0) {
      return commandsWereHandled;
    }

    console.info(`Processing command '${command.join(" ")}' for suggestion:`, options.suggestion);
    switch (command[0]) {

      case "ignore":
        const ignoreTarget = command.length > 1 ? command[1] : "this";
        commandsWereHandled = await this.processIgnoreCommand(ignoreTarget, options);
        break;

      default:
        warning(`Unknown command '${command[0]}'`);
        break;

    }

    return commandsWereHandled;
  }

  private async processIgnoreCommand(ignoreTarget: string, options: {
    suggestion: IFileSuggestion
  }) : Promise<boolean> {
    switch (ignoreTarget) {

      case "this":
        // Ignore this single misspelling instance using an inline code comment
        return patchFileWithInlineComment(options.suggestion.path, options.suggestion.lineNumber, options.suggestion.word);

      case "line":
        // Ignore all misspellings on line X using an inline code comment
        return patchFileWithInlineComment(options.suggestion.path, options.suggestion.lineNumber);

      case "word":
        // Add the word to the global ignored words list
        return patchCodespellConfig(this.configFilePath, null, options.suggestion.word);

      case "file":
        // Add the file to the global ignored files list
        return patchCodespellConfig(this.configFilePath, options.suggestion.path, null);

      case "file-type":
        // Add the file type to the global ignored files list
        return patchCodespellConfig(this.configFilePath, `*.${options.suggestion.path.split(".").pop()}`, null);

      case "dir":
        // Add the directory to the global ignored files list
        return patchCodespellConfig(this.configFilePath, `${options.suggestion.path.split(path.sep).splice(0, -1).join(path.sep)}${path.sep}*`, null);

      default:
        // Add a custom file path pattern to the global ignored files list
        return patchCodespellConfig(this.configFilePath, ignoreTarget, null);
    }
  }
}

 function patchCodespellConfig(configPath: string, addSkipPattern: string | null = null, addIgnoreWord: string | null = null) : boolean {
  try {
    const codeSpellConfigIni = fs.existsSync(configPath) ? ini.parse(fs.readFileSync(configPath, "utf-8")) : null;
    const codeSpellIniSection = codeSpellConfigIni?.codespell;
    if (!codeSpellConfigIni) {
      throw new Error("Config file not found or not a valid INI file");
    }
    if (addSkipPattern)
    {
      codeSpellIniSection["skip"] = (codeSpellIniSection["skip"] || '')
        .split(',')
        .filter((s: string) => s.trim().length > 0)
        .concat(addSkipPattern)
        .join(',');
    }
    if (addIgnoreWord)
    {
      codeSpellIniSection["ignore-words-list"] = (codeSpellIniSection["ignore-words-list"] || '')
        .split(',')
        .filter((s: string) => s.trim().length > 0)
        .concat(addIgnoreWord)
        .join(',');
    }
    fs.writeFileSync(configPath, ini.stringify(codeSpellConfigIni));
    return true;
  }
  catch (e) {
    error(`Failed to patch ${configPath}: ${e}`);
    return false;
  }
}

function patchFileWithInlineComment(filePath: string, lineNumber: number, word: string | null = null) : boolean {
  try {
    const lines = fs.readFileSync(filePath).toString().split("\n");
    const line = lines[lineNumber - 1];
    const codeCommentDelimiters = getCodeCommentDelimiters(filePath);
    const codespellIgnore = `codespell:ignore ${word || ''}`.trim();
    const codespellIgnoreComment = `${codeCommentDelimiters.start} ${codespellIgnore} ${codeCommentDelimiters.end || ''}`.trim();
    if (line.endsWith(codespellIgnoreComment)) {
      return false; // ignore comment already exists, skip
    }

    const newLineText = `${line} ${codespellIgnoreComment}`;
    lines[lineNumber - 1] = newLineText;
    fs.writeFileSync(filePath, Buffer.from(lines.join("\n")));
    return true;
  }
  catch (e) {
    error(`Failed to patch local file with inline comment: ${e}`);
    return false;
  }
}

function getCodeCommentDelimiters(filePath: string): { start: string; end: string | null } {
  const fileExtension = filePath.split('.').pop()?.toLowerCase();
  const delimiters: { [key: string]: { start: string; end: string | null } } = {
    'htm': { start: '<!--', end: '-->' },
    'html': { start: '<!--', end: '-->' },
    'cs': { start: '//', end: null },
    'cshtml': { start: '//', end: null },
    'js': { start: '//', end: null },
    'ts': { start: '//', end: null },
    'css': { start: '/*', end: '*/' },
    'scss': { start: '/*', end: '*/' },
    'java': { start: '//', end: null },
    'py': { start: '#', end: null },
    'xml': { start: '<!--', end: '-->' },
    'json': { start: '//', end: null },  // Not standard in JSON, but some tools accept it
    'sql': { start: '--', end: null },
    'php': { start: '//', end: null },
    'rb': { start: '#', end: null },
    'sh': { start: '#', end: null },
    'c': { start: '/*', end: '*/' },
    'cpp': { start: '//', end: null },
    'h': { start: '//', end: null },
    'swift': { start: '//', end: null },
    'kt': { start: '//', end: null }, // Kotlin
    'go': { start: '//', end: null },
    'rs': { start: '//', end: null }, // Rust
    'scala': { start: '//', end: null },
    'pl': { start: '#', end: null },  // Perl
    'r': { start: '#', end: null },
    'bat': { start: '::', end: null }, // Batch script
    'ps1': { start: '#', end: null }, // PowerShell
    'vb': { start: "'", end: null },  // Visual Basic
    'vbs': { start: "'", end: null }, // VBScript
    'asm': { start: ';', end: null }, // Assembly
    'hs': { start: '--', end: null }, // Haskell
    'erl': { start: '%', end: null }, // Erlang
    'ex': { start: '#', end: null }, // Elixir
    'exs': { start: '#', end: null }, // Elixir script
    'md': { start: '<!--', end: '-->' }, // Markdown (HTML comments)
    'rmd': { start: '<!--', end: '-->' }, // R Markdown
    'tex': { start: '%', end: null },  // LaTeX
    'm': { start: '%', end: null }, // MATLAB/Octave
    'jl': { start: '#', end: null }, // Julia
    'lua': { start: '--', end: null },
    'dart': { start: '//', end: null },
    'groovy': { start: '//', end: null },
    'tsql': { start: '--', end: null }, // T-SQL
    'vhd': { start: '--', end: null }, // VHDL
    'verilog': { start: '//', end: null },
    'awk': { start: '#', end: null },
    'm4': { start: 'dnl', end: null }, // m4 macro language
    'ml': { start: '(*', end: '*)' }, // OCaml
    'fs': { start: '//', end: null }, // F#
    'psql': { start: '--', end: null }, // PostgreSQL
    'sas': { start: '*', end: ';' }, // SAS
    'ada': { start: '--', end: null }, // Ada
    'coffee': { start: '#', end: null }, // CoffeeScript
    'clj': { start: ';', end: null }, // Clojure
    'cljs': { start: ';', end: null }, // ClojureScript
    'jsonc': { start: '//', end: null }, // JSON with comments
    'yaml': { start: '#', end: null },
    'yml': { start: '#', end: null },
    'toml': { start: '#', end: null },
    'ini': { start: ';', end: null },
    'cfg': { start: '#', end: null },
    'makefile': { start: '#', end: null },
    'dockerfile': { start: '#', end: null },
    'nginx': { start: '#', end: null }, // NGINX config files
    'http': { start: '#', end: null }, // HTTP request files
    'graphql': { start: '#', end: null }
  };

  // Return the comment delimiters based on the file extension
  return delimiters[fileExtension!] || { start: '//', end: null }; // Default to C-style comments
}

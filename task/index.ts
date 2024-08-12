import * as tl from "azure-pipelines-task-lib/task"
import { debug, warning, error } from "azure-pipelines-task-lib/task"
import { ToolRunner } from "azure-pipelines-task-lib/toolrunner"
import { AzureDevOpsClient, IFile, IFileSuggestion } from "./services/azureDevOpsClient";
import { parseExtensionConfiguration } from "./services/extensionConfigParser";

async function run() {
    try {

        let config = parseExtensionConfiguration();
        let ado: AzureDevOpsClient = new AzureDevOpsClient(config.organizationUri, config.project, config.repositoryId);

        if (config.skipIfCodeSpellConfigMissing && !config.hasCodeSpellConfigFile) {
            console.info("Skipping task as '.codespellrc' configuration file is missing and 'skipIfCodeSpellConfigMissing' is set.");
            tl.setResult(tl.TaskResult.Skipped, "No configuration found.");
            return;
        }
        
        if (config.pullRequestId > 0) {
            if (config.commitSuggestions) {
                console.info(`Any misspelling suggestions will be committed directly to PR #${config.pullRequestId}`);
            } else if (config.commentSuggestions) {
                console.info(`Any misspelling suggestions will be raised as comments in PR #${config.pullRequestId}`);
            }
        }

        // Process any user commands found in pull request comments (e.g. "@codespell ignore this") 
        // This ensures that `.codespellrc` is up to date before we run codespell
        if (config.pullRequestId > 0 && config.commentSuggestions) {
            console.info("Checking PR comments for new commands that need processing...");
            await ado.processUserCommandsInPullRequest({
                pullRequestId: config.pullRequestId
            });
        }

        // Install codespell if not already installed
        if (!tl.which("codespell", false)) {
            debug("Codespell was not found, installing via `pip install`...");
            let pipRunner: ToolRunner = tl.tool(tl.which("pip", true));
            pipRunner.arg(["install", "codespell", "chardet"]);
            pipRunner.execSync({
                silent: !config.debug
            });
        }

        // Run codespell
        console.info("Running codespell...");
        let codeSpellRunner: ToolRunner = tl.tool(tl.which("codespell", true));
        let codeSpellArguments = ["--quiet-level", "2", "--context", "0"];
        if (config.commitSuggestions) {
            codeSpellArguments.push("--write-changes");
        }
        codeSpellRunner.arg(codeSpellArguments);
        let codeSpellResult = codeSpellRunner.execSync({
            silent: !config.debug
        })
        debug(`codespell exited with code ${codeSpellResult.code}.`);

        // Parse codespell output
        let lineContext = '';
        let fixedFiles: IFile[] = [];
        let suggestions: IFileSuggestion[] = [];
        codeSpellResult.stdout.split(/[\r\n]+/).forEach((line: string) => {
            let suggestionMatch = line.match(/(.*):(\d+):(.*)==>(.*)/i);
            if (suggestionMatch) {
                suggestions.push({
                    path: suggestionMatch[1].trim(),
                    lineNumber: parseInt(suggestionMatch[2]),
                    lineText: lineContext.substring(1),
                    word: suggestionMatch[3].trim(),
                    suggestions: suggestionMatch[4].trim().split(',').map(s => s.trim())
                });
            }
            lineContext = line;
        });
        codeSpellResult.stderr.split(/[\r\n]+/).forEach((line: string) => {
            let fixedFileMatch = line.match(/FIXED\: (.*)/i);
            if (fixedFileMatch) {
                fixedFiles.push({
                    path: fixedFileMatch[1].trim()
                });
            }
            let warningMatch = line.match(/WARNING\: (.*)/i);
            if (warningMatch) {
                warning(warningMatch[1].trim());
            }
            let errorMatch = line.match(/ERROR\: (.*)/i);
            if (errorMatch) {
                error(errorMatch[1].trim());
            }
        });

        // Tell the user what we found
        let noMisspellingsFound = (suggestions.length === 0 && fixedFiles.length === 0);
        if (noMisspellingsFound) {
            console.info("No misspellings found.");
        }
        if (fixedFiles.length > 0) {
            console.info(`Fixed misspellings in ${fixedFiles.length} files:`);
            fixedFiles.forEach(f => console.info(` - ${f.path}`));
        }
        if (suggestions.length > 0) {
            warning(`Found ${suggestions.length} misspelling(s) ${config.commitSuggestions ? "that could not be automatically corrected" : "" }`);
            suggestions.forEach(c => warning(` - ${c.path}:${c.lineNumber} ${c.word} ==> ${c.suggestions.join(", ")}`));
        }

        // If anything was found, commit or comment suggestions to the PR (if configured)
        if (config.pullRequestId > 0) {
            if (config.commitSuggestions) {
                await ado.commitSuggestionsToPullRequest({
                    pullRequestId: config.pullRequestId,
                    fixedFiles: fixedFiles,
                    suggestions: config.commentSuggestions ? suggestions : []
                });
            }
            if (config.commentSuggestions) {
                await ado.commentSuggestionsOnPullRequest({
                    pullRequestId: config.pullRequestId,
                    suggestions: suggestions
                });
            }
        }

        tl.setResult(
            noMisspellingsFound 
                ? tl.TaskResult.Succeeded 
                : (!config.failOnMisspelling 
                    ? tl.TaskResult.SucceededWithIssues 
                    : tl.TaskResult.Failed),
            noMisspellingsFound
                ? "No misspellings found."
                : `Found ${suggestions.length} misspelling(s).`
        );
    }
    catch (err: any) {
        tl.setResult(tl.TaskResult.Failed, err.message);
    }
}

run();

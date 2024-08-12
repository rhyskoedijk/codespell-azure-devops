import { which, tool, setResult, TaskResult } from "azure-pipelines-task-lib/task"
import { debug, warning, error } from "azure-pipelines-task-lib/task"
import { ToolRunner } from "azure-pipelines-task-lib/toolrunner"
import { parseExtensionConfiguration } from "./services/extensionConfigParser";
import { CodespellRunner } from "./services/codespellRunner";
import { AzureDevOpsClient, IFile, IFileSuggestion } from "./services/azureDevOpsClient";

async function run() {
    try {

        const config = parseExtensionConfiguration();
        const ado: AzureDevOpsClient = new AzureDevOpsClient(config.organizationUri, config.project, config.repositoryId);

        if (config.skipIfCodeSpellConfigMissing && !config.hasCodeSpellConfigFile) {
            console.info("Skipping task because '.codespellrc' configuration file is missing and 'skipIfCodeSpellConfigMissing' is set.");
            setResult(TaskResult.Skipped, "No configuration found.");
            return;
        }

        if (config.pullRequestId > 0) {
            if (config.commitSuggestions) {
                console.info(`Suggestions will be committed directly to PR #${config.pullRequestId}.`);
            }
            if (config.commentSuggestions) {
                console.info(`Suggestions will be raised as comments in PR #${config.pullRequestId}.`);
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

        // Run codespell
        const codespell = await new CodespellRunner(config.debug).run({
            writeChanges: config.commitSuggestions
        });

        // Tell the user what we found
        const noMisspellingsFound = (codespell.suggestions.length === 0 && codespell.fixed.length === 0);
        if (noMisspellingsFound) {
            console.info("No misspellings found.");
        }
        if (codespell.fixed.length > 0) {
            console.info(`Fixed misspellings in ${codespell.fixed.length} files:`);
            codespell.fixed.forEach(f => console.info(` - ${f.path}`));
        }
        if (codespell.suggestions.length > 0) {
            warning(`Found ${codespell.suggestions.length} misspelling(s) ${config.commitSuggestions ? "that could not be automatically corrected" : ""}:`);
            codespell.suggestions.forEach(c => warning(` - ${c.path}:${c.lineNumber} ${c.word} ==> ${c.suggestions.join(", ")}`));
        }

        // If anything was found, commit or comment suggestions to the PR (if configured)
        if (config.pullRequestId > 0) {
            if (config.commitSuggestions) {
                await ado.commitSuggestionsToPullRequest({
                    pullRequestId: config.pullRequestId,
                    fixedFiles: codespell.fixed,
                    suggestions: config.commentSuggestions ? codespell.suggestions : []
                });
            }
            if (config.commentSuggestions) {
                await ado.commentSuggestionsOnPullRequest({
                    pullRequestId: config.pullRequestId,
                    suggestions: codespell.suggestions
                });
            }
        }

        // Report task result
        setResult(
            noMisspellingsFound
                ? TaskResult.Succeeded
                : (!config.failOnMisspelling
                    ? TaskResult.SucceededWithIssues
                    : TaskResult.Failed),
            noMisspellingsFound
                ? "No misspellings found."
                : `Found ${codespell.suggestions.length} misspelling(s).`
        );
    }
    catch (e: any) {
        error(`Unhandled exception: ${e}`);
        setResult(TaskResult.Failed, e?.message);
    }
}

run();

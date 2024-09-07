import { setResult, TaskResult } from "azure-pipelines-task-lib/task"
import { debug, warning, error } from "azure-pipelines-task-lib/task"
import { parseExtensionConfiguration } from "./services/extensionConfigParser";
import { CodespellRunner } from "./services/codespellRunner";
import { AzureDevOpsClient, IPullRequstLock } from "./services/azureDevOpsClient";

async function run() {
    const config = parseExtensionConfiguration();
    const ado = new AzureDevOpsClient(config.organizationUri, config.project, config.repositoryId);
    let prLock: IPullRequstLock | null = null;
    try {

        if (config.skipIfCodeSpellConfigMissing && !config.hasCodeSpellConfigFile) {
            console.info("Skipping task because '.codespellrc' configuration file is missing and 'skipIfCodeSpellConfigMissing' is set.");
            setResult(TaskResult.Skipped, "No configuration found.");
            return;
        }

        if (config.pullRequestId > 0) {
            prLock = await ado.acquireLockForPullRequest(config.pullRequestId, config.jobId);
            if (!prLock.wasAcquired || prLock.ownerJobId !== config.jobId) {
                console.info(`Skipping task because another instance of codespell is already running for this PR in ${prLock.ownerJobId ? "job " + prLock.ownerJobId : "another job"}.`);
                setResult(TaskResult.Skipped, "Another instance is already running.");
                return;
            }
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
            console.info("Checking PR comments for commands that need processing...");
            await ado.processCommandsInCommentsForPullRequest({
                pullRequestId: config.pullRequestId
            });
        }

        // Run codespell
        const codespell = await new CodespellRunner(config.debug).run({
            writeChanges: config.commitSuggestions,
            postFixCommand: config.postFixCommand
        });

        // Commit and comment on all suggestions in the PR (if configured)
        if (config.pullRequestId > 0) {
            if (config.commitSuggestions) {
                await ado.commitSuggestionsToPullRequest({
                    pullRequestId: config.pullRequestId,
                    files: [...new Set([...codespell.fixed, ...codespell.modified])],
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

        // TODO: Set pull request status for "Codespell check succeeded"
        // https://learn.microsoft.com/en-us/rest/api/azure/devops/git/pull-request-statuses/create?view=azure-devops-rest-7.1&tabs=HTTP
        
        // Report task result
        const noMisspellingsFound = (codespell.suggestions.length === 0);
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
    finally {
        if (config.pullRequestId > 0 && prLock?.wasAcquired) {
            await ado.releaseLockForPullRequest(config.pullRequestId);
        }
    }
}

run();

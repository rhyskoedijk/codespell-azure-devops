import * as tl from "azure-pipelines-task-lib/task"
import fs from "fs";
import ini from "ini";

export interface IExtensionConfig {
  organizationUri: string;
  project: string;
  repositoryId: string;
  pullRequestId: number;

  hasCodeSpellConfigFile: boolean;
  commitSuggestions: boolean;
  commentSuggestions: boolean;
  failOnMisspelling: boolean;
  debug: boolean;
}

interface ICodeSpellConfigDevOpsSection {
  "commit-changes": any;
  "comment-suggestions": any;
  "fail-on-misspelling": any;
}

export function parseExtensionConfiguration(): IExtensionConfig {
  let organizationUri = tl.getVariable("System.CollectionUri");
  if (!organizationUri) {
    throw new Error("Required variable 'System.CollectionUri' is not set");
  }

  let project = tl.getVariable("System.TeamProject");
  if (!project) {
    throw new Error("Required variable 'System.TeamProject' is not set");
  }

  let repositoryId = tl.getVariable("Build.Repository.ID");
  if (!repositoryId) {
    throw new Error("Required variable 'Build.Repository.ID' is not set");
  }

  // If a .codespellrc file is present, parse it
  let hasCodeSpellConfigFile = fs.existsSync(".codespellrc");
  let codeSpellConfig = ini.parse(fs.readFileSync(".codespellrc", "utf-8"));
  let codeSpellDevOpsConfig = codeSpellConfig?.devops as ICodeSpellConfigDevOpsSection;
  if (hasCodeSpellConfigFile && codeSpellConfig) {
    console.log("Found '.codespellrc' configuration:", JSON.stringify(codeSpellConfig, null, 2));
  }

  return {
    organizationUri: organizationUri,
    project: project,
    repositoryId: repositoryId,
    pullRequestId: parseInt(tl.getVariable("System.PullRequest.PullRequestId") || "0"),

    hasCodeSpellConfigFile: hasCodeSpellConfigFile,
    commitSuggestions: tl.getBoolInput("commitSuggestions", false) || codeSpellDevOpsConfig?.["commit-changes"] !== undefined || false,
    commentSuggestions: tl.getBoolInput("commentSuggestions", false) || codeSpellDevOpsConfig?.["comment-suggestions"] !== undefined || false,
    failOnMisspelling: tl.getBoolInput("failOnMisspelling", false) || codeSpellDevOpsConfig?.["fail-on-misspelling"] !== undefined || false,
    debug: tl.getVariable("System.Debug")?.toLowerCase() === "true"
  };
}

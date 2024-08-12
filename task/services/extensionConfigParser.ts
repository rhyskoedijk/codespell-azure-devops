import { getVariable, getBoolInput } from "azure-pipelines-task-lib/task"
import fs from "fs";
import ini from "ini";

export interface IExtensionConfig {
  organizationUri: string;
  project: string;
  repositoryId: string;
  pullRequestId: number;

  hasCodeSpellConfigFile: boolean;
  skipIfCodeSpellConfigMissing: boolean;
  commitSuggestions: boolean;
  commentSuggestions: boolean;
  failOnMisspelling: boolean;
  debug: boolean;
}

interface ICodeSpellConfigDevOpsSection {
  "commit-suggestions": any;
  "comment-suggestions": any;
  "fail-on-misspelling": any;
}

export function parseExtensionConfiguration(): IExtensionConfig {
  const organizationUri = getVariable("System.CollectionUri");
  if (!organizationUri) {
    throw new Error("Required variable 'System.CollectionUri' is not set");
  }

  const project = getVariable("System.TeamProject");
  if (!project) {
    throw new Error("Required variable 'System.TeamProject' is not set");
  }

  const repositoryId = getVariable("Build.Repository.ID");
  if (!repositoryId) {
    throw new Error("Required variable 'Build.Repository.ID' is not set");
  }

  // If a .codespellrc file is present, parse it
  const hasCodeSpellConfigFile = fs.existsSync(".codespellrc");
  const codeSpellConfig = fs.existsSync(".codespellrc") ? ini.parse(fs.readFileSync(".codespellrc", "utf-8")) : null;
  const codeSpellDevOpsConfig = codeSpellConfig?.devops as ICodeSpellConfigDevOpsSection;
  if (hasCodeSpellConfigFile && codeSpellConfig) {
    console.info("Found '.codespellrc' configuration:", JSON.stringify(codeSpellConfig, null, 2));
  }

  return {
    organizationUri: organizationUri,
    project: project,
    repositoryId: repositoryId,
    pullRequestId: parseInt(getVariable("System.PullRequest.PullRequestId") || "0"),

    hasCodeSpellConfigFile: hasCodeSpellConfigFile,
    skipIfCodeSpellConfigMissing: getBoolInput("skipIfCodeSpellConfigMissing", false),
    commitSuggestions: getBoolInput("commitSuggestions", false) || (codeSpellDevOpsConfig?.["commit-suggestions"] !== undefined) || false,
    commentSuggestions: getBoolInput("commentSuggestions", false) || (codeSpellDevOpsConfig?.["comment-suggestions"] !== undefined) || false,
    failOnMisspelling: getBoolInput("failOnMisspelling", false) || (codeSpellDevOpsConfig?.["fail-on-misspelling"] !== undefined) || false,
    debug: getVariable("System.Debug")?.toLowerCase() === "true"
  };
}

<h1>
    <picture>
        <img src="https://raw.githubusercontent.com/rhyskoedijk/codespell-azure-devops/main/images/icon.png" alt="Codespell" width="30" height="30" />
    </picture>
    <span>Codespell Azure DevOps Extension</span>
</h1>

This extension runs [codespell](https://github.com/codespell-project/codespell) over your code. Any misspellings can be automatically fixed via a commit, or suggested using a pull request suggestion comment. Suggestions can reviewed and fixed directly from the pull request comment thread, without needing to push further commits. 

![example](https://raw.githubusercontent.com/rhyskoedijk/codespell-azure-devops/main/images/example.png)

## Install

Install the extension from the [Visual Studio marketplace](https://marketplace.visualstudio.com/items?itemName=rhyskoedijk.codespell).

## Usage
It's recommended to run codespell in your pull request build validation pipeline(s) as early as possible, ideally immediately after source code checkout to avoid doing unesscary build tasks when missepllings are found.

In YAML pipelines:

```yaml
jobs:
- job: build
  steps:
  - checkout: self
  - task: codespell@1

  # your other build tasks here...
```

**The identity used to run codespell must have "Contribute" permission to the repository.**

If no service connection or access token is specified in the task input, the "Project Collection Build Service" identity will be used to commit and comment on pull requests, which requires that the "Allow scripts to access the OAuth token" option be enabled on the pipeline.

It is recommended to add a `.codespellrc`  configuration file to the root directory of your repository. Refer to [Azure DevOps configuration file](#azure-devops-configuration-file) for more on how to configure codespell. If a config option is specified in both `.codespellrc` **and** the task inputs, the task input value takes priority.

## Azure DevOps configuration file
In addition to all built-in [codespell configuration file options](https://github.com/codespell-project/codespell?tab=readme-ov-file#using-a-config-file), these additional configuration are supported by this extension:

```ini
[codespell]
; Your codespell config goes here...
; https://github.com/codespell-project/codespell?tab=readme-ov-file#using-a-config-file

[devops]
; These options are specific to the Azure DevOps extension and have no effect if codespell is run manually.

; When misspellings are found, suggested fixes will be committed directly to the source branch of the pull request associated with the run.
; This setting is ignored if the pipeline run is not in the context of a pull request.
commit-suggestions = 

; When misspellings are found, suggested fixes will be added as comments to the pull request associated with the run.
; This setting is ignored if the pipeline run is not in the context of a pull request.
comment-suggestions = 

; Additional command(s) to run after fixing misspellings.
; This can be used to run code linting tools, if required.
post-fix-command = 

; When misspellings are found, the pipeline will fail with error "X misspellings found".
; By default, misspellings are raised as warnings only.
fail-on-misspelling = 

; Log additional information to assist with debugging
debug = 
```

## How to phase in codespell to existing projects

Introducing spelling checks to an existing project can be distruptive if there are a lot of existing missepllings. This is a step-by-step guide on how to fix existing missepllings via a pull request and then guard against new missepllings in future pull requests.

1. [Enable codespell in your pull request build validation pipeline(s)](#usage)
1. Create a new feature branch (e.g. `/feature/codespell`)
1. Add `.codespellrc` to `/feature/codespell` with some basic skip path rules and ignored words that you expect to encounter in your code. e.g.
    ```ini
    [codespell]
    hard-encoding-detection = 
    skip = bin,obj,lib,node_modules,fonts,*.pdf,*.png,*.css
    ignore-words-list = 
    
    [devops]
    fail-on-misspelling = 
    debug = 
    ```
1. Create a pull request for `/feature/codespell` and wait for build validation pipelines to trigger codespell
1. Review the codespell warnings and refine your "skip" and "ignore-words-list" configuration until only legitimate misspellings remain
1. Edit `.codespellrc`; Enable "commit-suggestions" and "comment-suggestions"
    ```ini
    [codespell]
    ; your final codespell goes config here...

    [devops]
    commit-suggestions = ; this will commit fixes for misspellings that can be automatically resolved
    comment-suggestions = ; this will add suggestion comments for misspellings that have multiple options and require manual intervention
    fail-on-misspelling = 
    debug = 
    ```
1. Wait for build validation pipelines to re-run, codespell will push a commit and comment on the pull request with all remaining suggestions that cannot be auto-resolved
1. Manually review and apply suggestions for all remaining misspellings
1. Edit `.codespellrc`; Disable "commit-suggestions" and "debug" so that going forward, all suggestions are raised as pull request comments only
    ```ini
    [codespell]
    ; your final codespell goes config here...

    [devops]
    comment-suggestions = 
    fail-on-misspelling = 
    ```
1. Merge the pull request, with all misspellings now resolved; New pull requests will misspellings will block merge until the comment suggestions are resolved.

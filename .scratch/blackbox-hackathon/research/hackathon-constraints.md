# BLACKBOX Hackathon Constraints

Research date: 2026-08-24. Sources are limited to first-party pages from the event organizer, TrueFoundry/TrueForge, and Qodo.

## Decision summary

BLACKBOX is a valid fit for **The Agent Harness Hackathon (TF-007)**, but the Spec v0.1 and delivery plan must treat these as hard gates:

1. BLACKBOX itself must run through TrueForge, and the demo must make the harness's real work visible; a thin UI around a model call does not qualify. The organizer's minimum demonstration is a real tool call, generated code running in a sandbox, and a human stop before an irreversible action. ([event overview](https://www.wemakedevs.org/hackathons/trueforge), [official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))
2. The repository may start private, but it must be **public, open source, readable, and runnable by the submission deadline**. A permanently private repository would be ineligible. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))
3. The final package must include the public source repository, a reproducible README, an approximately three-minute working demo, and a short explanation of the agent and its TrueForge use. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))
4. To preserve the strongest Qodo evidence and eligibility for Best Code Quality, connect Qodo before implementation PRs, develop through multiple PRs, let Qodo review each one, and resolve or explicitly answer findings before merge. ([event overview](https://www.wemakedevs.org/hackathons/trueforge))

## Event, dates, and eligibility

- The official event is **The Agent Harness Hackathon**, organized by WeMakeDevs with TrueFoundry, and its build window is August 24–30, 2026. It starts at **07:00 UTC on August 24** and ends at **19:00 UTC on August 30**. That converts to **04:00 on August 24 through 16:00 on August 30 in São Paulo (UTC−3)**. ([official schedule](https://www.wemakedevs.org/hackathons/trueforge/schedule))
- Participation is free and global online. A participant may work solo or in one team of at most four people, and each person may belong to only one team. BLACKBOX's one-developer assumption is therefore valid. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))
- Registration is the channel through which the organizer says participants receive the stream link and submission form. The public event pages currently expose the registration form but not a separate final-submission URL, so the registered email, event site, and WeMakeDevs Discord must be monitored. ([event overview](https://www.wemakedevs.org/hackathons/trueforge))
- Online participants must provide their own model API key. The advertised US$50 OpenAI credit is only for the separate, capacity-limited San Francisco day on August 29, which requires its own registration. ([event overview](https://www.wemakedevs.org/hackathons/trueforge), [official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))

## Build-period and content restrictions

- Coding and design must occur inside the official build window. Ideas, notes, architecture planning, and diagrams may exist beforehand; frameworks, open-source libraries, public APIs, templates, third-party tools, public assets, and AI coding assistants are allowed. Only original work completed during the event is judged. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))
- AI-assistant use must be disclosed. The participant must understand and be able to explain the code, architecture, agent, and technical choices; an essentially AI-generated project without meaningful human contribution, verification, or understanding may be rejected. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))
- Every connected tool, dataset, and account must be owned by the participant or used with permission. Private, personal, and login-protected information must stay out of both repository and demo. This supports BLACKBOX's controlled synthetic canary/sink strategy and rules out third-party or uncontrolled targets. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))
- Plagiarism, judging manipulation, rule violations, or Code of Conduct violations can cause disqualification. Intellectual property created during the hackathon remains with its creator or team. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))

## TrueForge and sponsor-use requirements

For basic qualification, TrueForge cannot merely sit under a wrapper: the judge must see the agent running through the harness and doing real work. The organizer says every submission should visibly reach a real tool, execute code in the sandbox, and pause for a person before an irreversible action. ([event overview](https://www.wemakedevs.org/hackathons/trueforge), [official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))

For the Best Use of TrueForge track, the official description rewards fuller use of the harness: real MCP-connected tools, generated code executing in a sandbox, human approval before irreversible actions, delegation to subagents, and a session that survives reconnects. The last two are track-strengthening capabilities, not stated general eligibility gates. ([event overview](https://www.wemakedevs.org/hackathons/trueforge))

The official TrueForge repository confirms that MCP tools, isolated Daytona sandbox execution, human checkpoints, subagents, session state, TypeScript SDK/API access, and an embeddable UI are current harness capabilities. The event page also says TrueFoundry's AI Gateway and MCP Gateway are not required for this hackathon. ([TrueForge repository](https://github.com/truefoundry/trueforge), [event overview](https://www.wemakedevs.org/hackathons/trueforge))

## Judging and prize tracks

All submissions are scored on six equally weighted criteria, and the demo is weighted as heavily as the code: potential impact; creativity and originality; technical excellence; use of sponsor tools; control and safety; and presentation. The sponsor criterion asks whether TrueForge is central and whether Qodo reviewed PRs; the safety criterion asks whether code ran safely and execution stopped before irreversible action. ([event overview](https://www.wemakedevs.org/hackathons/trueforge))

Every submission is considered for all three judged tracks, but one team can win at most one:

- **Best Use of TrueForge:** strongest substantive harness use; prize is one NVIDIA DGX Spark for the team.
- **Best Code Quality:** a cloneable, understandable, extensible repository with an authentic Qodo review trail; prize is one Mac Mini for the team.
- **Best UI:** a usable interface that shows what the agent is doing, waiting on, and has done, and asks before an irreversible step; judged from the demo and running project, with one iPad per winning team member.

These track definitions and prize allocation are stated on the [event overview](https://www.wemakedevs.org/hackathons/trueforge) and [official rules](https://www.wemakedevs.org/hackathons/trueforge/rules). A blog prize is separate and optional; entering it requires publishing a post and including its link in the submission. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))

## Repository, submission, and demo artifacts

By **August 30 at 20:00 London / 19:00 UTC / 16:00 São Paulo**, submit through the event site:

- a public source-code repository;
- a clear README with setup steps sufficient for a judge to run it;
- a demo video of about three minutes that shows the agent working;
- a short write-up explaining what the agent does and how it uses TrueForge;
- a blog-post link only if entering the blog prize.

The artifact list and London deadline are explicit in the [official rules](https://www.wemakedevs.org/hackathons/trueforge/rules); the UTC deadline is confirmed by the [official schedule](https://www.wemakedevs.org/hackathons/trueforge/schedule). No official rule found specifies a video host, a hard second-by-second duration cap, a repository hosting provider, or a particular open-source license. Adding a standard `LICENSE` is therefore a prudent reproducibility/open-source measure, not a stated event requirement.

The requested personal GitHub repository is compatible with the published rules because they do not require an organization-owned repository. Its lifecycle must be written as **private during development, public before submission**, with secrets and private data removed from both the current tree and Git history before publication. The publication transition is mandatory; the temporary private phase is not prohibited. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))

## Qodo workflow and official inconsistency

The official pages conflict slightly:

- The overview's “What every submission needs” checklist includes Qodo installed at the start with reviewed PRs, and Qodo review is part of the equally weighted sponsor-tools judging criterion. ([event overview](https://www.wemakedevs.org/hackathons/trueforge))
- The rules page's footnote says Qodo-reviewed PRs are required only to win Best Code Quality and that nothing else in the hackathon depends on Qodo. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))

The safe delivery interpretation is to use Qodo from the first implementation PR even if BLACKBOX does not prioritize Best Code Quality. The official winning workflow is: install at the start, work through PRs instead of direct-to-main, let Qodo review each PR, then fix valid findings or explain disagreements before merging. A single last-minute PR is explicitly described as insufficient evidence for the track. ([event overview](https://www.wemakedevs.org/hackathons/trueforge))

A private development repository does not prevent this workflow: Qodo documents private-repository support through its GitHub App with explicit repository access. Its current pricing page advertises a 14-day trial without a credit card and says qualified public open-source projects can apply for free ongoing access. ([Qodo private-repository documentation](https://docs.qodo.ai/code-review/troubleshooting/review-comments-not-appearing), [Qodo pricing](https://www.qodo.ai/pricing/))

## Comparison with inherited BLACKBOX assumptions

| Prior assumption | Official finding | Spec/delivery consequence |
| --- | --- | --- |
| Build in the developer's personal GitHub account and keep the repository private initially. | A personal repo is not forbidden, and a temporary private phase is compatible; the submitted repo must be public and open source. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules)) | Create it private, give Qodo explicit access, then scrub and publish before the deadline. Do not promise permanent privacy. |
| Deliver a truthful demo in about three minutes. | This matches the required video length and the judging emphasis on a visibly working agent. ([event overview](https://www.wemakedevs.org/hackathons/trueforge), [official rules](https://www.wemakedevs.org/hackathons/trueforge/rules)) | Preserve the narrow end-to-end narrative; record real execution, not a screenshot or visual mock. |
| Use real tools, sandbox, approval, policy change, and replay with synthetic company data. | Real tool use, sandbox execution, and the approval pause align directly with qualification and judging; owned/authorized synthetic data is compatible. ([event overview](https://www.wemakedevs.org/hackathons/trueforge), [official rules](https://www.wemakedevs.org/hackathons/trueforge/rules)) | Make TrueForge's role observable in the demo and keep all targets controlled. |
| Plan before implementation. | Pre-event ideas, notes, architecture, and diagrams are allowed, but coding and design must occur during the event window. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules)) | Retain planning provenance and ensure implementation/design commits fall inside the official window. |
| Focus on BLACKBOX rather than multiple ideas/features. | The organizer explicitly advises one narrow job completed end to end over a partially finished platform. ([event overview](https://www.wemakedevs.org/hackathons/trueforge)) | Keep extensions after the canonical flow and submission gates. |

## Open uncertainties to monitor

- The final submission form/URL is not currently linked publicly; registration is said to deliver it. ([event overview](https://www.wemakedevs.org/hackathons/trueforge))
- The public rules do not state when judging results will be announced. ([official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))
- The Qodo wording conflict should be treated conservatively: use it throughout, while recognizing that the rules page makes it a hard eligibility requirement only for Best Code Quality. ([event overview](https://www.wemakedevs.org/hackathons/trueforge), [official rules](https://www.wemakedevs.org/hackathons/trueforge/rules))

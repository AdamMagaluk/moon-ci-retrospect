import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import * as core from "@actions/core";

import { parseJson } from "@moonrepo/dev";

import type { Action, ActionStatus, OperationMetaTaskExecution, RunReport } from "@moonrepo/types";

async function loadReport(workspaceRoot: string): Promise<RunReport | null> {
	for (const fileName of ["ciReport.json", "runReport.json"]) {
		const localPath = path.join(".moon/cache", fileName);

		const reportPath = path.join(workspaceRoot, localPath);

		core.debug(`Finding run report at ${localPath}`);

		if (await fileExists(reportPath)) {
			core.debug("Found!");

			return parseJson<RunReport>(reportPath);
		}
	}

	return null;
}

async function main(): Promise<void> {
	const root = process.cwd();

	const report = await loadReport(root);

	if (!report) {
		core.warning("Run report does not exist, has `moon ci` or `moon run` ran?");

		return;
	}

	// Check if we're in a GitHub Actions environment
	const isGitHubActions = process.env["GITHUB_ACTIONS"] === "true";
	
	// Initialize GitHub Actions summary (only if in GitHub Actions)
	let summary: any = null;
	if (isGitHubActions) {
		summary = core.summary
			.addHeading("Moon CI Retrospect Results")
			.addRaw("This report shows the results of Moon CI task executions.\n");
	}

	// Track task results for summary
	const taskResults: Array<{
		target: string;
		status: ActionStatus;
		command: string | undefined;
		hasStdout: boolean;
		hasStderr: boolean;
		stdout: string | undefined;
		stderr: string | undefined;
	}> = [];

	for (const action of report.actions) {
		if (action.node.action !== "run-task") {
			continue;
		}

		const { project, task } = parseTarget(action.node.params.target);
		const target = `${project}:${task}`;

		const command = commandOf(action);

		const { stdout, stderr } = await readStatus(root, { project, task });

		const hasStdout = stdout.trim() !== "";
		const hasStderr = stderr.trim() !== "";

		// Store task results for summary
		taskResults.push({
			target,
			status: action.status,
			command: typeof command === "string" ? command : undefined,
			hasStdout,
			hasStderr,
			stdout: hasStdout ? stdout : undefined,
			stderr: hasStderr ? stderr : undefined,
		});

		// Console output (existing functionality)
		core.startGroup(`${statusBadges[action.status]} ${bold(target)}`);

		if (typeof command === "string") {
			console.log(blue(`$ ${command}`));
		}

		if (hasStdout) {
			console.log(stdBadges.out);
			console.log(stdout);
		}

		if (hasStderr) {
			console.log(stdBadges.err);
			console.log(stderr);
		}

		core.endGroup();
	}

	// Build GitHub Actions summary (only if in GitHub Actions environment)
	if (isGitHubActions && summary && taskResults.length > 0) {
		// Create summary table
		const tableRows = taskResults.map(({ target, status, command, hasStdout, hasStderr }) => {
			const statusEmoji = getStatusEmoji(status);
			const outputs = [];
			if (hasStdout) outputs.push("📤 stdout");
			if (hasStderr) outputs.push("📥 stderr");
			
			return [
				{ data: target, header: false },
				{ data: `${statusEmoji} ${status}`, header: false },
				{ data: command || "-", header: false },
				{ data: outputs.join(", ") || "-", header: false },
			];
		});

		summary
			.addTable([
				[
					{ data: "Task", header: true },
					{ data: "Status", header: true },
					{ data: "Command", header: true },
					{ data: "Outputs", header: true },
				],
				...tableRows,
			])
			.addBreak();

		// Add detailed results for each task
		for (const result of taskResults) {
			summary.addHeading(`Task: ${result.target}`, 3);
			
			if (result.command) {
				summary.addCodeBlock(result.command, "bash");
			}

			if (result.hasStdout) {
				summary.addHeading("STDOUT", 4);
				summary.addCodeBlock(result.stdout!, "text");
			}

			if (result.hasStderr) {
				summary.addHeading("STDERR", 4);
				summary.addCodeBlock(result.stderr!, "text");
			}

			summary.addBreak();
		}

		// Write the summary
		await summary.write();
	}
}

interface TargetIdentity {
	task: (string & {}) | "unknown";
	project: (string & {}) | "unknown";
}

function sanitizeProjectName(project: string): string {
	return project.replace(/\//g, "-");
}

function getStatusEmoji(status: ActionStatus): string {
	switch (status) {
		case "passed":
			return "✅";
		case "failed":
		case "timed-out":
		case "aborted":
		case "invalid":
		case "failed-and-abort":
			return "❌";
		case "skipped":
			return "⏭️";
		case "cached":
		case "cached-from-remote":
			return "💾";
		case "running":
			return "🏃";
		default:
			return "❓";
	}
}

function parseTarget(target: string): TargetIdentity {
	const parts = target.split(":");

	const project = parts[0] ?? "unknown";
	const task = parts[1] ?? "unknown";

	return { project, task };
}

function commandOf(action: Action): OperationMetaTaskExecution["command"] {
	for (const operation of action.operations) {
		if (operation.meta.type === "task-execution") {
			return operation.meta.command;
		}
	}

	return undefined;
}

async function readStatus(
	workspaceRoot: string,
	{ project, task }: TargetIdentity,
): Promise<{ stdout: string; stderr: string }> {
	const sanitizedProject = sanitizeProjectName(project);
	const statusDir = `${workspaceRoot}/.moon/cache/states/${sanitizedProject}/${task}`;

	const stdoutPath = `${statusDir}/stdout.log`;
	const stderrPath = `${statusDir}/stderr.log`;

	const stdout = (await fileExists(stdoutPath)) ? await readFile(stdoutPath, { encoding: "utf8" }) : "";

	const stderr = (await fileExists(stderrPath)) ? await readFile(stderrPath, { encoding: "utf8" }) : "";

	return { stdout, stderr };
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await stat(path);

		return true;
	} catch {
		return false;
	}
}

const statusBadges: Record<ActionStatus, string> = {
	running: bgGreen(" RUNNING "),
	passed: bgGreen(" PASS "),

	failed: bgRed(" FAIL "),
	"timed-out": bgRed(" TIMED OUT "),
	aborted: bgRed(" ABORTED "),
	invalid: bgRed(" INVALID "),
	"failed-and-abort": bgRed(" FAILED AND ABORT "),

	skipped: bgBlue(" SKIP "),
	cached: bgBlue(" CACHED "),
	"cached-from-remote": bgBlue(" REMOTE CACHED "),
};

function bgGreen(text: string): string {
	return `\u001b[42m${text}\u001b[49m`;
}

function bgRed(text: string): string {
	return `\u001b[41m${text}\u001b[49m`;
}

function bgBlue(text: string): string {
	return `\u001b[44m${text}\u001b[49m`;
}

function bgDarkGray(text: string): string {
	return `\u001b[48;5;236m${text}\u001b[49m`;
}

function bold(text: string): string {
	return `\u001b[1m${text}\u001b[22m`;
}

function green(text: string): string {
	return `\u001b[32m${text}\u001b[39m`;
}

function red(text: string): string {
	return `\u001b[31m${text}\u001b[39m`;
}

function blue(text: string): string {
	return `\u001b[34m${text}\u001b[39m`;
}

const stdBadges = {
	out: bgDarkGray(`　${green("⏺")} STDOUT　`),
	err: bgDarkGray(`　${red("⏺")} STDERR　`),
} as const;

try {
	await main();
} catch (error) {
	console.error(error);
	process.exit(0);
}

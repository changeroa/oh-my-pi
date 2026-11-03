import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult } from "@oh-my-pi/pi-tui/overlays/ask-dialog";
import type { NativeUserInteractionResponse } from "./user-interactions";

/** Reject unrelated fields instead of silently discarding approval scope or ask answers. */
export function validateInteractionResponse(response: NativeUserInteractionResponse, fields: readonly string[]): void {
	if (!response || typeof response !== "object" || (response.kind !== "submit" && response.kind !== "cancel"))
		throw new Error("Invalid native interaction response");
	const allowed = response.kind === "cancel" ? ["kind"] : ["kind", ...fields];
	if (Object.keys(response).some(key => !allowed.includes(key)))
		throw new Error("Response fields do not match this interaction kind");
}

export function nativeTextResponse(response: NativeUserInteractionResponse): string | undefined {
	validateInteractionResponse(response, ["value"]);
	if (response.kind === "cancel") return undefined;
	if (typeof response.value !== "string") throw new Error("Text interaction requires a string value");
	return response.value;
}

export function nativeConfirmResponse(response: NativeUserInteractionResponse): boolean {
	validateInteractionResponse(response, ["value"]);
	if (response.kind === "cancel") return false;
	if (typeof response.value !== "boolean") throw new Error("Confirmation requires a boolean value");
	return response.value;
}

export function nativeChoiceResponse(
	response: NativeUserInteractionResponse,
	options: readonly { id: string; disabled?: boolean }[],
): string | undefined {
	validateInteractionResponse(response, ["choice"]);
	if (response.kind === "cancel") return undefined;
	if (!options.some(option => option.id === response.choice && !option.disabled))
		throw new Error("Choice is not offered by this native interaction");
	return response.choice;
}

export function nativeAskResponse(
	questions: ExtensionAskDialogQuestion[],
	response: NativeUserInteractionResponse,
): ExtensionAskDialogResult | undefined {
	validateInteractionResponse(response, ["answers"]);
	if (response.kind === "cancel") return undefined;
	if (!Array.isArray(response.answers) || response.answers.length !== questions.length)
		throw new Error("Ask requires one answer per question in native order");
	const answers = response.answers;
	return {
		kind: "submit",
		results: questions.map((question, index) => {
			const answer = answers[index];
			const options = question.options.map(option => option.label);
			if (
				!answer ||
				answer.id !== question.id ||
				Object.keys(answer).some(key => !["id", "selectedOptions", "customInput", "note"].includes(key))
			)
				throw new Error("Ask question IDs/order do not match");
			if (
				!Array.isArray(answer.selectedOptions) ||
				answer.selectedOptions.some(label => typeof label !== "string" || !options.includes(label)) ||
				new Set(answer.selectedOptions).size !== answer.selectedOptions.length
			)
				throw new Error("Ask selection contains unknown or duplicate labels");
			if (
				(answer.customInput !== undefined && typeof answer.customInput !== "string") ||
				(answer.note !== undefined && typeof answer.note !== "string")
			)
				throw new Error("Ask custom input and note must be text");
			const custom = !!answer.customInput?.trim();
			if (!question.multi && answer.selectedOptions.length + Number(custom) !== 1)
				throw new Error("Ask answer violates selection constraints");
			return {
				id: question.id,
				question: question.question,
				options,
				multi: question.multi ?? false,
				selectedOptions: [...answer.selectedOptions],
				customInput: answer.customInput,
				note: answer.note,
			};
		}),
	};
}

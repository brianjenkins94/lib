/**
 * Schema drift classifier: walk an OBSERVED schema against a SPEC schema (allOf-aware) and emit typed
 * Issues describing where the spec is wrong — missing/extra fields, wrong type/nullability, a required field
 * the spec left optional, structural mismatches. Pure — no I/O. The accessors live in [[./introspect]].
 * A consumer wraps this as "drift" (observed API traffic vs an accepted spec).
 */
import { describeSchema, getItems, getProperties, getRequired, isNullable, isOpenSchema, primaryType } from "./introspect.js";

export interface Issue {
	"fieldPath": string;
	"issueType": "MISSING_FIELD" | "EXTRA_FIELD" | "WRONG_TYPE" | "WRONG_NULLABILITY" | "MISSING_REQUIRED" | "WRONG_ENUM" | "STRUCTURAL" | "OTHER";
	"specValue": string;
	"observedValue": string;
	"suggestedFix": string;
}

const MAX_DEPTH = 8;

/** Compare an OBSERVED (ground-truth) schema against a SPEC schema, pushing Issues onto `issues`. */
export function compare(observed: any, spec: any, path: string, issues: Issue[], depth = 0): void {
	if (depth > MAX_DEPTH || !observed || observed === true || isOpenSchema(spec)) {
		return;
	}

	const observedType = primaryType(observed);
	const specType = primaryType(spec);

	if (isNullable(observed) && !isNullable(spec)) {
		issues.push({ "fieldPath": path, "issueType": "WRONG_NULLABILITY", "specValue": "not nullable", "observedValue": "nullable", "suggestedFix": "Add `nullable: true`" });
	}

	if (observedType === "unknown") {
		return;
	}

	if (specType !== "unknown") {
		const compatible = observedType === specType
			|| (observedType === "number" && specType === "integer")
			|| (observedType === "integer" && specType === "number");

		if (!compatible) {
			issues.push({ "fieldPath": path, "issueType": "WRONG_TYPE", "specValue": specType, "observedValue": observedType, "suggestedFix": `Change type to \`${observedType}\`${isNullable(observed) ? ", nullable: true" : ""}` });

			return;
		}
	}

	if (observedType === "array") {
		const observedItems = getItems(observed);
		const specItems = getItems(spec);

		if (specType !== "array") {
			issues.push({ "fieldPath": path, "issueType": "STRUCTURAL", "specValue": describeSchema(spec), "observedValue": describeSchema(observed), "suggestedFix": "Change to array type" });

			return;
		}

		if (observedItems && specItems) {
			compare(observedItems, specItems, `${path}[]`, issues, depth + 1);
		}

		return;
	}

	if (observedType === "object") {
		const observedProps = getProperties(observed);
		const specProps = getProperties(spec) as Record<string, any>;
		const observedRequired = getRequired(observed);
		const specRequired = getRequired(spec);

		for (const [key, observedProperty] of Object.entries(observedProps)) {
			if (key !== "$schema") {
				const specProperty = specProps[key];

				if (specProperty === undefined) {
					issues.push({ "fieldPath": `${path}.${key}`, "issueType": "MISSING_FIELD", "specValue": "(absent)", "observedValue": describeSchema(observedProperty), "suggestedFix": `Add property \`${key}: ${describeSchema(observedProperty)}\`` });
				} else {
					if (observedRequired.has(key) && !specRequired.has(key)) {
						issues.push({ "fieldPath": `${path}.${key}`, "issueType": "MISSING_REQUIRED", "specValue": "optional", "observedValue": "required", "suggestedFix": `Add \`${key}\` to \`required\`` });
					}

					compare(observedProperty, specProperty, `${path}.${key}`, issues, depth + 1);
				}
			}
		}
	}
}

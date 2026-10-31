// The feature workflow and the doc rules, shipped inside agt and generated as skills (see agents/skill.ts). Edit them
// here, never in the generated copies.
import featureWorkflow from "./feature-workflow.md" with { type: "text" };
import manageDocs from "./manage-docs.md" with { type: "text" };
import spec from "./templates/spec.md" with { type: "text" };
import ticket from "./templates/ticket.md" with { type: "text" };
import release from "./templates/release.md" with { type: "text" };

export const FEATURE_WORKFLOW: string = featureWorkflow;
export const MANAGE_DOCS: string = manageDocs;
export const TEMPLATES: Record<"spec" | "ticket" | "release", string> = { spec, ticket, release };

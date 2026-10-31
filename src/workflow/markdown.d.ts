// Markdown imported as text (`import x from "./f.md" with { type: "text" }`), which Bun inlines.
declare module "*.md" {
  const text: string;
  export default text;
}

declare module "acorn-jsx" {
  import type { Parser } from "acorn";
  type ParserPlugin = (BaseParser: typeof Parser) => typeof Parser;
  export default function jsx(options?: {
    allowNamespaces?: boolean;
    allowNamespacedObjects?: boolean;
  }): ParserPlugin;
}

import type { ClaudeContentBlock } from "../constants.js";
export type ChatContent = string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
export type ResponsesContent = Array<{ type: "input_text"; text: string } | { type: "input_image"; image_url: string }>;

export function toChatContent(content: string | ClaudeContentBlock[]): ChatContent {
  if (typeof content === "string") return content;
  return content.map(block => {
    if (block.type === "text") return { type: "text", text: block.text };
    const source = block.source;
    const url = source.type === "url" ? source.url : `data:${source.media_type};base64,${source.data}`;
    return { type: "image_url", image_url: { url } };
  });
}

export function toResponsesContent(content: string | ClaudeContentBlock[]): ResponsesContent {
  const chat = toChatContent(content);
  if (typeof chat === "string") return [{ type: "input_text", text: chat }];
  return chat.map(block => block.type === "text" ? { type: "input_text", text: block.text } : { type: "input_image", image_url: block.image_url.url });
}

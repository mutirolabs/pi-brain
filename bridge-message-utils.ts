export const appendAttachmentContext = (content: string, attachmentContext?: string): string => {
  const context = (attachmentContext || "").trim();
  if (!context) return content;
  return content ? `${content}\n\n${context}` : context;
};

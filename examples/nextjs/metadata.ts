export function articleMetadata(revision: string): { other: Record<string, string> } {
  return {
    other: {
      'hiden-cache-revision': revision,
    },
  };
}

export function rootHtml(releaseId: string): string {
  return `<html data-dpl-id="${releaseId}">`;
}

import { useQuery } from '@tanstack/react-query';
import type { DocSummary, TagCount } from '@tsumiwiki/shared';
import { api } from './client';
import { TAGS_QUERY_KEY } from './docs';

export function useTags() {
  return useQuery({
    queryKey: TAGS_QUERY_KEY,
    queryFn: async () => {
      const { tags } = await api<{ tags: TagCount[] }>('GET', '/api/tags');
      return tags;
    },
  });
}

export function useDocsByTags(tags: string[]) {
  return useQuery({
    queryKey: [...TAGS_QUERY_KEY, 'docs', tags],
    queryFn: async () => {
      const { docs } = await api<{ docs: DocSummary[] }>(
        'GET',
        `/api/tags/docs?tags=${encodeURIComponent(tags.join(','))}`,
      );
      return docs;
    },
    enabled: tags.length > 0,
  });
}

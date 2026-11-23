import { useQuery } from '@tanstack/react-query';
import { apiBytes } from '../../api/client';

/**
 * The served bytes for the viewer (watermarked per viewer for confidential
 * files). Kept in memory only: gcTime 0, never written to any browser storage.
 */
export function useFileBytes(fileId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['file-bytes', fileId],
    queryFn: () => apiBytes(`/files/${fileId}/view`),
    enabled,
    gcTime: 0,
    staleTime: Infinity,
    retry: false,
  });
}

import { MEDIA_TYPES, type AnimationFormat, type CosmeticType } from '@bigboss/shared';
import { mediaTypeOfUrl } from './upload';

export const cosmeticTypeLabel = (t: CosmeticType) => t.replace(/_/g, ' ');

/** The format to play `url` as: the stored one, else what its extension says. */
export function formatOf(url: string, format?: AnimationFormat | null): AnimationFormat {
  if (format && format !== 'none') return format;
  const type = mediaTypeOfUrl(url);
  return type ? MEDIA_TYPES[type].format : 'none';
}

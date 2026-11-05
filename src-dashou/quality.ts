import type { AudioQuality, CodecType, VideoQuality } from './types'

const VIDEO_QUALITY: Record<number, VideoQuality> = {
  6: '240P',
  16: '360P',
  32: '480P',
  64: '720P',
  74: '720P60',
  80: '1080P',
  100: 'AiRepair',
  112: '1080P+',
  116: '1080P60',
  120: '4K',
  125: 'HDR',
  126: 'Dolby',
  127: '8K'
}

const AUDIO_QUALITY: Record<number, AudioQuality> = {
  30216: '64K',
  100008: '64K',
  30232: '132K',
  100009: '132K',
  30280: '192K',
  100010: '192K',
  30250: 'Dolby',
  30251: 'HiRes'
}

const CODEC_TYPE: Record<number, CodecType> = {
  0: 'Audio',
  7: 'AVC',
  12: 'HEVC',
  13: 'AV1'
}

export function toVideoQuality(id: number): VideoQuality {
  return VIDEO_QUALITY[id] ?? 'Unknown'
}

export function toAudioQuality(id: number): AudioQuality {
  return AUDIO_QUALITY[id] ?? 'Unknown'
}

export function toCodecType(codecid: number): CodecType {
  return CODEC_TYPE[codecid] ?? 'Unknown'
}

export interface AvailableMediaFormats {
  video_qualities_and_codec_types: Array<{ video_quality: VideoQuality; codec_type: CodecType }>
  audio_qualities: AudioQuality[]
}

interface MediaLike {
  id: number
  codecid?: number
}

interface MediaUrlLike {
  quality?: number
  video_codecid?: number
  dash?: { video?: MediaLike[]; audio?: MediaLike[]; dolby?: { audio?: MediaLike[] | null }; flac?: { audio?: MediaLike | null } | null } | null
  durl?: Array<{ order: number; url: string }>
  durls?: Array<{ quality: number; durl: Array<{ url: string }> }>
}

/** 和 Rust 的 to_get_available_media_formats_result 保持一致 */
export function availableFormats(mediaUrl: MediaUrlLike): AvailableMediaFormats {
  const video_qualities_and_codec_types: AvailableMediaFormats['video_qualities_and_codec_types'] = []
  const audio_qualities: AudioQuality[] = []

  for (const media of mediaUrl.dash?.video ?? []) {
    video_qualities_and_codec_types.push({
      video_quality: toVideoQuality(media.id),
      codec_type: toCodecType(media.codecid ?? -1)
    })
  }

  if ((mediaUrl.durl?.length ?? 0) > 0) {
    video_qualities_and_codec_types.push({
      video_quality: toVideoQuality(mediaUrl.quality ?? -1),
      codec_type: toCodecType(mediaUrl.video_codecid ?? -1)
    })
  }

  for (const media of mediaUrl.dash?.audio ?? []) {
    audio_qualities.push(toAudioQuality(media.id))
  }
  for (const media of mediaUrl.dash?.dolby?.audio ?? []) {
    audio_qualities.push(toAudioQuality(media.id))
  }
  const flacAudio = mediaUrl.dash?.flac?.audio
  if (flacAudio !== null && flacAudio !== undefined) {
    audio_qualities.push(toAudioQuality(flacAudio.id))
  }

  return { video_qualities_and_codec_types, audio_qualities }
}

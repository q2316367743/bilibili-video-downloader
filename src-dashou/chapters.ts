/** 章节 / 广告片段：把多个区间合并成 ffmpeg FFMETADATA1 */
export interface ChapterSegment {
  title: string
  start: number
  end: number
}

function overlaps(s1: ChapterSegment, s2: ChapterSegment): boolean {
  return s1.start < s1.end && s2.start < s2.end && s1.start < s2.end && s2.start < s1.end
}

export class ChapterSegments {
  segments: ChapterSegment[] = []

  /** 新片段覆盖已有片段的重叠部分，其余部分保留并重新排序 */
  insert(newSegment: ChapterSegment): void {
    const processed: ChapterSegment[] = []
    for (const segment of this.segments) {
      if (!overlaps(segment, newSegment)) {
        processed.push({ ...segment })
        continue
      }
      const leftEnd = Math.min(segment.end, newSegment.start)
      if (segment.start < leftEnd) {
        processed.push({ title: segment.title, start: segment.start, end: leftEnd })
      }
      const rightStart = Math.max(segment.start, newSegment.end)
      if (rightStart < segment.end) {
        processed.push({ title: segment.title, start: rightStart, end: segment.end })
      }
    }
    processed.push({ ...newSegment })
    processed.sort((a, b) => a.start - b.start)
    this.segments = processed
  }

  generateChapterMetadata(videoDurationSeconds: number): string {
    const writeSegment = (title: string, start: number, end: number): string =>
      `[CHAPTER]\nTIMEBASE=1/1\nSTART=${start}\nEND=${end}\ntitle=${title}\n`

    const videoDuration = Number.isFinite(videoDurationSeconds)
      ? Math.trunc(videoDurationSeconds)
      : 0
    let content = ';FFMETADATA1\n'
    let lastEnd = 0
    for (const segment of this.segments) {
      if (segment.start > lastEnd) {
        content += writeSegment(' ', lastEnd, segment.start)
      }
      content += writeSegment(segment.title, segment.start, segment.end)
      lastEnd = segment.end
    }
    if (videoDuration > lastEnd) {
      content += writeSegment(' ', lastEnd, videoDuration)
    }
    return content
  }
}

const SKIP_TITLES: Record<string, string> = {
  sponsor: '广告',
  selfpromo: '无偿/自我推广',
  exclusive_access: '柔性推广/品牌合作',
  interaction: '三连/订阅提醒',
  poi_highlight: '精彩时刻/重点',
  intro: '过场/开场动画',
  outro: '鸣谢/结束画面',
  preview: '回顾/概要'
}

export function skipSegmentToChapter(segment: Record<string, unknown>): ChapterSegment | null {
  const times = segment['segment']
  if (!Array.isArray(times) || times.length < 2) return null
  const category = String(segment['category'] ?? '')
  const title = SKIP_TITLES[category]
  if (title === undefined) return null
  const start = Math.trunc(Number(times[0]))
  const end = Math.trunc(Number(times[1]))
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null
  return { title, start, end }
}

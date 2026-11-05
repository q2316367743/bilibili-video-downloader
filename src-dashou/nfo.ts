import type { BangumiInfo, CheeseInfo, NormalInfo } from './types'

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function tag(name: string, value: string | number, indent: string): string {
  return `${indent}<${name}>${escapeXml(String(value))}</${name}>`
}

function tags(name: string, values: Array<string | number>, indent: string): string {
  return values.map((value) => tag(name, value, indent)).join('\n')
}

function dateParts(timestampSeconds: number): { premiered: string; year: number } {
  const date = new Date(timestampSeconds * 1000)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return { premiered: `${year}-${month}-${day}`, year }
}

function joinLines(parts: Array<string | null>): string {
  return `${parts.filter((part): part is string => part !== null && part !== '').join('\n')}\n`
}

export function normalToMovieNfo(info: NormalInfo, tagsList: Array<{ tag_name: string }>): string {
  const { premiered, year } = dateParts(info.pubdate)
  const genre = ['Bilibili视频', info.tname, info.tname_v2].filter((item) => item !== '')
  const tagValues = tagsList.map((item) => item.tag_name).filter((name) => name !== '')
  const actors = (info.staff ?? []).map((staff, index) =>
    joinLines([
      '    <actor>',
      tag('name', staff.name, '      '),
      tag('role', staff.title, '      '),
      tag('order', index, '      '),
      tag('thumb', staff.face, '      '),
      '    </actor>'
    ])
  )

  const set = info.ugc_season
    ? joinLines([
        '  <set>',
        tag('name', info.ugc_season.title, '    '),
        tag('overview', info.ugc_season.intro, '    '),
        '  </set>'
      ])
    : ''

  return joinLines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<movie>',
    tag('title', info.title, '  '),
    tag('plot', info.desc, '  '),
    tag('runtime', Math.floor(info.duration / 60), '  '),
    tag('premiered', premiered, '  '),
    tag('year', year, '  '),
    tags('studio', ['Bilibili'], '  '),
    tags('genre', genre, '  '),
    tags('tag', tagValues, '  '),
    set,
    tags('director', [info.owner.name], '  '),
    ...actors,
    '</movie>'
  ])
}

function bangumiGenre(info: BangumiInfo): string[] {
  const typeName: Record<number, string> = {
    1: '番剧',
    2: '电影',
    3: '纪录片',
    4: '国创',
    5: '电视剧',
    6: '漫画',
    7: '综艺'
  }
  const result: string[] = []
  const name = typeName[info.type]
  if (name !== undefined) result.push(`Bilibili${name}`)
  for (const style of info.styles) {
    if (style !== '') result.push(style)
  }
  return result
}

function bangumiCountry(info: BangumiInfo): string[] {
  return info.areas.map((area) => area.name).filter((name) => name !== '')
}

function bangumiDirector(info: BangumiInfo): string[] {
  return info.up_info ? [info.up_info.uname] : []
}

function parseDateTime(text: string): { premiered: string; year: number } {
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(text)
  if (match !== null) {
    const year = Number(match[1])
    const month = String(Number(match[2])).padStart(2, '0')
    const day = String(Number(match[3])).padStart(2, '0')
    return { premiered: `${year}-${month}-${day}`, year }
  }
  const date = new Date(text.replace(' ', 'T'))
  if (Number.isNaN(date.getTime())) return { premiered: '', year: 0 }
  return dateParts(Math.floor(date.getTime() / 1000))
}

export function bangumiToTvshowNfo(info: BangumiInfo): string {
  const { premiered, year } = parseDateTime(info.publish.pub_time)
  const status = info.publish.is_finish === 0 ? 'Continuing' : 'Ended'
  return joinLines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<tvshow>',
    tag('title', info.title, '  '),
    tag('plot', info.evaluate, '  '),
    tag('tagline', info.share_sub_title, '  '),
    tag('premiered', premiered, '  '),
    tag('year', year, '  '),
    tags('studio', ['Bilibili'], '  '),
    tag('status', status, '  '),
    tags('genre', bangumiGenre(info), '  '),
    tags('country', bangumiCountry(info), '  '),
    tags('director', bangumiDirector(info), '  '),
    '</tvshow>'
  ])
}

export function findBangumiEpisode(
  info: BangumiInfo,
  epId: number
): { episode: BangumiInfo['episodes'][number]; order: number } | null {
  const inMain = info.episodes.findIndex((ep) => ep.id === epId)
  if (inMain >= 0) {
    const episode = info.episodes[inMain]
    if (episode !== undefined) return { episode, order: inMain + 1 }
  }
  for (const section of info.section ?? []) {
    const index = section.episodes.findIndex((ep) => ep.id === epId)
    if (index >= 0) {
      const episode = section.episodes[index]
      if (episode !== undefined) return { episode, order: index + 1 }
    }
  }
  return null
}

export function bangumiToEpisodeNfo(info: BangumiInfo, epId: number): string {
  const found = findBangumiEpisode(info, epId)
  if (found === null) throw new Error('找不到对应章节')
  const { episode, order } = found
  const { premiered, year } = dateParts(episode.pub_time)
  const title = episode.show_title ?? episode.title
  const plot = episode.share_copy ?? ''
  const runtime = Math.floor((episode.duration ?? 0) / 1000 / 60)
  return joinLines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<episodedetails>',
    tag('title', title, '  '),
    tag('plot', plot, '  '),
    tag('runtime', runtime, '  '),
    tag('premiered', premiered, '  '),
    tag('year', year, '  '),
    tag('episode', order, '  '),
    tags('studio', ['Bilibili'], '  '),
    tags('genre', bangumiGenre(info), '  '),
    tags('country', bangumiCountry(info), '  '),
    tags('director', bangumiDirector(info), '  '),
    '</episodedetails>'
  ])
}

export function cheeseToTvshowNfo(info: CheeseInfo): string {
  const first = info.episodes[0]
  const { premiered, year } = first !== undefined ? dateParts(first.release_date) : { premiered: '', year: 0 }
  const status = info.release_status === '已完结' ? 'Ended' : 'Continuing'
  return joinLines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<tvshow>',
    tag('title', info.title, '  '),
    tag('plot', info.subtitle, '  '),
    tag('premiered', premiered, '  '),
    tag('year', year, '  '),
    tags('studio', ['Bilibili'], '  '),
    tag('status', status, '  '),
    tags('genre', ['Bilibili课程'], '  '),
    tags('director', [info.up_info.uname], '  '),
    '</tvshow>'
  ])
}

export function cheeseToEpisodeNfo(info: CheeseInfo, epId: number): string {
  const episode = info.episodes.find((ep) => ep.id === epId)
  if (episode === undefined) throw new Error('找不到对应课程章节')
  const { premiered, year } = dateParts(episode.release_date)
  return joinLines([
    '<?xml version="1.0" encoding="utf-8"?>',
    '<episodedetails>',
    tag('title', episode.title, '  '),
    tag('plot', episode.subtitle, '  '),
    tag('runtime', Math.floor(episode.duration / 60), '  '),
    tag('premiered', premiered, '  '),
    tag('year', year, '  '),
    tag('episode', episode.index, '  '),
    tags('studio', ['Bilibili'], '  '),
    tags('genre', ['Bilibili课程'], '  '),
    tags('director', [info.up_info.uname], '  '),
    '</episodedetails>'
  ])
}

import { updateBuffer, type TagPatch } from 'music-metadata'

// Keep the download settings independent of the ID3 writer's field names.
export function downloadTagPatch(tags: Record<string, any>): TagPatch {
  const native: Record<string, any> = {}
  const textFrames: Record<string, string> = {
    title: 'TIT2', artist: 'TPE1', album: 'TALB', performerInfo: 'TPE2',
    trackNumber: 'TRCK', partOfSet: 'TPOS', genre: 'TCON', year: 'TDRC',
    bpm: 'TBPM', ISRC: 'TSRC', publisher: 'TPUB', copyright: 'TCOP',
    composer: 'TCOM', length: 'TLEN'
  }
  for (const [field, frame] of Object.entries(textFrames)) {
    if (tags[field] !== undefined) native[frame] = String(tags[field])
  }
  // ID3v2.4 stores the full recording date in TDRC.
  if (tags.date) native.TDRC = String(tags.date)
  for (const entry of tags.userDefinedText || []) native[`TXXX:${entry.description}`] = entry.value
  if (tags.comment) native.COMM = tags.comment
  if (tags.unsynchronisedLyrics) native.USLT = tags.unsynchronisedLyrics
  if (tags.synchronisedLyrics) {
    native.SYLT = tags.synchronisedLyrics.map((lyrics: any) => ({
      language: lyrics.language,
      timeStampFormat: lyrics.timeStampFormat,
      contentType: lyrics.contentType,
      syncText: lyrics.synchronisedText.map((line: any) => ({ text: line.text, timestamp: line.timeStamp }))
    }))
  }
  const patch: TagPatch = { native }
  if (tags.image) patch.picture = [{
    format: tags.image.mime,
    type: 'Cover (front)',
    description: tags.image.description,
    data: tags.image.imageBuffer
  }]
  return patch
}

export async function tagDownloadedMp3(buffer: Uint8Array, tags: Record<string, any>): Promise<Buffer> {
  return Buffer.from(await updateBuffer(buffer, downloadTagPatch(tags), { replaceId3: true }))
}

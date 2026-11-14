import * as fs from 'fs'
import * as path from 'path'

const DATA_DIR = process.env.DEEMIX_DATA_DIR || '/config'
const MUSIC_DIR = process.env.DEEMIX_MUSIC_DIR || '/downloads'

fs.mkdirSync(DATA_DIR, { recursive: true })
fs.mkdirSync(MUSIC_DIR, { recursive: true })

export const app = {
  isPackaged: true,
  setName: (_name: string) => {},
  getVersion: () => process.env.npm_package_version || '2.6.6',
  getPath: (name: string): string => {
    switch (name) {
      case 'userData':
      case 'appData':
      case 'logs':
        return DATA_DIR
      case 'music':
      case 'downloads':
        return MUSIC_DIR
      case 'temp':
        return '/tmp'
      default:
        return path.join(DATA_DIR, name)
    }
  }
}

export default { app }

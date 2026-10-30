import type { UveApi } from '../../preload'

declare global {
  interface Window {
    uve: UveApi
  }
}

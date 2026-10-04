<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
// Single source of truth: What's New is parsed from CHANGELOG.md at build
// time, so the in-app list and the GitHub release notes can never drift.
import changelogRaw from '../../CHANGELOG.md?raw'

const { t } = useI18n()

const appVersion = ref('')
const runtimeInfo = ref<{ electron: string; chromium: string; node: string; v8: string; os: string } | null>(null)

onMounted(async () => {
  if (window.electronAPI) {
    appVersion.value = await window.electronAPI.getVersion()
    runtimeInfo.value = await window.electronAPI.getRuntimeInfo()
  }
})

function openLink(url: string) {
  if (window.electronAPI) {
    window.electronAPI.openExternal(url)
  } else {
    window.open(url, '_blank')
  }
}

// What's New — grouped by version, newest first. Older versions are
// summarized into a single "Earlier releases" entry to keep this page
// scannable. Full history lives in CHANGELOG.md.
interface ReleaseNotes {
  version: string
  date: string
  items: string[]
}

// Derived from CHANGELOG.md. The [Unreleased] section is omitted (users see
// shipped versions only); the "Earlier releases" pointer renders as its own
// entry. Bold/link/code markdown is flattened to plain text for the list.
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

function parseChangelog(md: string): ReleaseNotes[] {
  const releases: ReleaseNotes[] = []
  let cur: ReleaseNotes | null = null
  for (const raw of md.split('\n')) {
    const line = raw.replace(/\s+$/, '')
    const vh = line.match(/^## \[([0-9][0-9.]*)\]\s*-\s*(.+)$/)
    if (vh) {
      cur = { version: vh[1], date: vh[2].trim(), items: [] }
      releases.push(cur)
      continue
    }
    if (/^## Earlier releases/i.test(line)) {
      cur = { version: 'earlier', date: '', items: [] }
      releases.push(cur)
      continue
    }
    if (/^## /.test(line)) { cur = null; continue }   // [Unreleased] or other top-level section
    if (/^### /.test(line)) continue                  // category subheading (Added / Fixed / ...)
    if (!cur) continue
    if (/^- /.test(line)) {
      const item = stripMarkdown(line.replace(/^- /, ''))
      if (item) cur.items.push(item)
    } else if (cur.version === 'earlier') {
      const item = stripMarkdown(line)
      if (item) cur.items.push(item)
    }
  }
  return releases
}

const whatsNew: ReleaseNotes[] = parseChangelog(changelogRaw)
</script>

<template>
  <div class="space-y-8 max-w-3xl">
    <!-- App Identity -->
    <div class="bg-background-secondary/60 border border-white/[0.08] p-8 text-center">
      <div class="flex justify-center mb-4">
        <div class="w-20 h-20 overflow-hidden border border-white/[0.08]">
          <img src="/icon.png" alt="Deemix Remastered" class="w-full h-full object-cover" />
        </div>
      </div>
      <h1 class="font-display uppercase text-[26px] tracking-[0.02em] mb-1">{{ t('about.appName') }}</h1>
      <p class="text-foreground-muted mb-3">{{ t('about.tagline') }}</p>
      <div class="inline-flex items-center px-2 py-1 font-mono text-[11px] tracking-[0.08em] bg-primary-500/10 text-primary-400 border border-primary-500/30">
        v{{ appVersion }}
      </div>
    </div>

    <!-- What's New -->
    <div class="bg-background-secondary/60 border border-white/[0.08] p-6">
      <h2 class="font-display text-[15px] uppercase tracking-[0.06em] mb-4 flex items-center gap-2">
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
        </svg>
        {{ t('about.whatsNew') }}
      </h2>
      <div class="space-y-5">
        <div v-for="release in whatsNew" :key="release.version" class="space-y-2">
          <div class="flex items-baseline gap-2 pb-1 border-b border-white/[0.06]">
            <h3 class="font-mono text-[12px] font-semibold text-foreground">
              {{ release.version === 'earlier' ? t('about.earlierReleases') : `v${release.version}` }}
            </h3>
            <span class="font-mono text-[10px] tracking-[0.04em] text-foreground-muted">{{ release.date }}</span>
          </div>
          <ul class="space-y-1.5">
            <li v-for="(item, i) in release.items" :key="i" class="flex items-start gap-2 text-sm text-foreground-muted">
              <span class="text-primary-400 mt-0.5 flex-shrink-0">&bull;</span>
              <span>{{ item }}</span>
            </li>
          </ul>
        </div>
      </div>
    </div>

    <!-- Runtime Info -->
    <div class="bg-background-secondary/60 border border-white/[0.08] p-6" v-if="runtimeInfo">
      <h2 class="font-display text-[15px] uppercase tracking-[0.06em] mb-4 flex items-center gap-2">
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
        </svg>
        {{ t('about.runtimeInfo') }}
      </h2>
      <div class="grid grid-cols-2 gap-3">
        <div class="bg-background-main/60 border border-white/[0.06] p-3">
          <p class="font-mono text-[9.5px] tracking-[0.2em] uppercase text-foreground-muted mb-1">Electron</p>
          <p class="text-sm font-mono">{{ runtimeInfo.electron }}</p>
        </div>
        <div class="bg-background-main/60 border border-white/[0.06] p-3">
          <p class="font-mono text-[9.5px] tracking-[0.2em] uppercase text-foreground-muted mb-1">Chromium</p>
          <p class="text-sm font-mono">{{ runtimeInfo.chromium }}</p>
        </div>
        <div class="bg-background-main/60 border border-white/[0.06] p-3">
          <p class="font-mono text-[9.5px] tracking-[0.2em] uppercase text-foreground-muted mb-1">Node.js</p>
          <p class="text-sm font-mono">{{ runtimeInfo.node }}</p>
        </div>
        <div class="bg-background-main/60 border border-white/[0.06] p-3">
          <p class="font-mono text-[9.5px] tracking-[0.2em] uppercase text-foreground-muted mb-1">V8</p>
          <p class="text-sm font-mono">{{ runtimeInfo.v8 }}</p>
        </div>
      </div>
    </div>

    <!-- Links -->
    <div class="bg-background-secondary/60 border border-white/[0.08] p-6">
      <h2 class="font-display text-[15px] uppercase tracking-[0.06em] mb-4 flex items-center gap-2">
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
        {{ t('about.links') }}
      </h2>
      <div class="space-y-2">
        <button
          @click="openLink('https://github.com/DRAZY/deemix-remastered')"
          class="w-full flex items-center gap-3 p-3 border border-white/[0.06] hover:border-white/20 hover:bg-background-tertiary/50 transition-colors text-left"
        >
          <svg class="w-5 h-5 text-foreground-muted flex-shrink-0" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
          </svg>
          <div>
            <p class="text-sm font-medium">{{ t('about.githubRepo') }}</p>
            <p class="text-xs text-foreground-muted">{{ t('about.githubRepoDesc') }}</p>
          </div>
          <svg class="w-4 h-4 text-foreground-muted ml-auto flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>
        <button
          @click="openLink('https://github.com/DRAZY/deemix-remastered/issues')"
          class="w-full flex items-center gap-3 p-3 border border-white/[0.06] hover:border-white/20 hover:bg-background-tertiary/50 transition-colors text-left"
        >
          <svg class="w-5 h-5 text-foreground-muted flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div>
            <p class="text-sm font-medium">{{ t('about.reportIssue') }}</p>
            <p class="text-xs text-foreground-muted">{{ t('about.reportIssueDesc') }}</p>
          </div>
          <svg class="w-4 h-4 text-foreground-muted ml-auto flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
          </svg>
        </button>
      </div>
    </div>

    <!-- Credits & License -->
    <div class="bg-background-secondary/60 border border-white/[0.08] p-6">
      <h2 class="font-display text-[15px] uppercase tracking-[0.06em] mb-4 flex items-center gap-2">
        <svg class="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
        </svg>
        {{ t('about.credits') }}
      </h2>
      <div class="space-y-3 text-sm text-foreground-muted">
        <p>{{ t('about.builtBy') }}</p>
        <p>{{ t('about.inspiredBy') }}</p>
        <div class="pt-3 border-t border-white/[0.06]">
          <p class="flex items-center gap-2">
            <svg class="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            {{ t('about.license') }}
          </p>
        </div>
      </div>
    </div>

    <!-- Disclaimer -->
    <p class="text-xs text-foreground-muted text-center pb-4">
      {{ t('about.disclaimer') }}
    </p>
  </div>
</template>

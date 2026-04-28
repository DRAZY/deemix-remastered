<script setup lang="ts">
defineProps<{
  code: string
  size?: number
}>()

function getCountryCode(localeCode: string): string {
  // Map locale codes to country codes
  const localeToCountry: Record<string, string> = {
    'en': 'gb',
    'ar': 'sa',
    'de': 'de',
    'el': 'gr',
    'es': 'es',
    'fil': 'ph',
    'fr': 'fr',
    'hr': 'hr',
    'id': 'id',
    'it': 'it',
    'ko': 'kr',
    'pl': 'pl',
    'pt-br': 'br',
    'pt-pt': 'pt',
    'ru': 'ru',
    'sr': 'rs',
    'th': 'th',
    'tr': 'tr',
    'vi': 'vn',
    'zh-cn': 'cn',
    'zh-tw': 'tw'
  }
  return localeToCountry[localeCode] || 'gb'
}
</script>

<template>
  <svg
    :width="size || 24"
    :height="size || 24"
    viewBox="0 0 48 48"
    class="flag-icon"
  >
    <defs>
      <clipPath id="circleClip">
        <circle cx="24" cy="24" r="23" />
      </clipPath>
    </defs>

    <g clip-path="url(#circleClip)">
      <!-- Great Britain -->
      <template v-if="getCountryCode(code) === 'gb'">
        <rect width="48" height="48" fill="#012169"/>
        <path d="M0 0L48 48M48 0L0 48" stroke="#FFFFFF" stroke-width="8"/>
        <path d="M0 0L48 48M48 0L0 48" stroke="#C8102E" stroke-width="4"/>
        <path d="M24 0V48M0 24H48" stroke="#FFFFFF" stroke-width="12"/>
        <path d="M24 0V48M0 24H48" stroke="#C8102E" stroke-width="6"/>
      </template>

      <!-- Saudi Arabia -->
      <template v-else-if="getCountryCode(code) === 'sa'">
        <rect width="48" height="48" fill="#006C35"/>
        <text x="24" y="28" text-anchor="middle" fill="#FFFFFF" font-size="10" font-weight="bold">SA</text>
      </template>

      <!-- Germany (horizontal tricolor) -->
      <template v-else-if="getCountryCode(code) === 'de'">
        <rect width="48" height="16" y="0" fill="#000000"/>
        <rect width="48" height="16" y="16" fill="#DD0000"/>
        <rect width="48" height="16" y="32" fill="#FFCE00"/>
      </template>

      <!-- Greece -->
      <template v-else-if="getCountryCode(code) === 'gr'">
        <rect width="48" height="48" fill="#0D5EAF"/>
        <rect width="48" height="5.3" y="5.3" fill="#FFFFFF"/>
        <rect width="48" height="5.3" y="16" fill="#FFFFFF"/>
        <rect width="48" height="5.3" y="26.7" fill="#FFFFFF"/>
        <rect width="48" height="5.3" y="37.3" fill="#FFFFFF"/>
        <rect width="18" height="18" fill="#0D5EAF"/>
        <rect width="18" height="4" y="7" fill="#FFFFFF"/>
        <rect width="4" height="18" x="7" fill="#FFFFFF"/>
      </template>

      <!-- Spain -->
      <template v-else-if="getCountryCode(code) === 'es'">
        <rect width="48" height="12" y="0" fill="#AA151B"/>
        <rect width="48" height="24" y="12" fill="#F1BF00"/>
        <rect width="48" height="12" y="36" fill="#AA151B"/>
      </template>

      <!-- Philippines -->
      <template v-else-if="getCountryCode(code) === 'ph'">
        <rect width="48" height="24" y="0" fill="#0038A8"/>
        <rect width="48" height="24" y="24" fill="#CE1126"/>
        <polygon points="0,0 24,24 0,48" fill="#FFFFFF"/>
        <circle cx="10" cy="24" r="4" fill="#FCD116"/>
      </template>

      <!-- France (vertical tricolor) -->
      <template v-else-if="getCountryCode(code) === 'fr'">
        <rect width="16" height="48" x="0" fill="#002395"/>
        <rect width="16" height="48" x="16" fill="#FFFFFF"/>
        <rect width="16" height="48" x="32" fill="#ED2939"/>
      </template>

      <!-- Croatia -->
      <template v-else-if="getCountryCode(code) === 'hr'">
        <rect width="48" height="16" y="0" fill="#FF0000"/>
        <rect width="48" height="16" y="16" fill="#FFFFFF"/>
        <rect width="48" height="16" y="32" fill="#171796"/>
        <rect x="17" y="8" width="14" height="16" fill="#FF0000"/>
        <rect x="19" y="10" width="4" height="4" fill="#FFFFFF"/>
        <rect x="25" y="10" width="4" height="4" fill="#FFFFFF"/>
        <rect x="19" y="18" width="4" height="4" fill="#FFFFFF"/>
        <rect x="25" y="18" width="4" height="4" fill="#FFFFFF"/>
        <rect x="22" y="14" width="4" height="4" fill="#FFFFFF"/>
      </template>

      <!-- Indonesia (horizontal bicolor) -->
      <template v-else-if="getCountryCode(code) === 'id'">
        <rect width="48" height="24" y="0" fill="#FF0000"/>
        <rect width="48" height="24" y="24" fill="#FFFFFF"/>
      </template>

      <!-- Italy (vertical tricolor) -->
      <template v-else-if="getCountryCode(code) === 'it'">
        <rect width="16" height="48" x="0" fill="#009246"/>
        <rect width="16" height="48" x="16" fill="#FFFFFF"/>
        <rect width="16" height="48" x="32" fill="#CE2B37"/>
      </template>

      <!-- South Korea -->
      <template v-else-if="getCountryCode(code) === 'kr'">
        <rect width="48" height="48" fill="#FFFFFF"/>
        <circle cx="24" cy="24" r="10" fill="#CD2E3A"/>
        <path d="M24 14 A10 10 0 0 1 24 34 A5 5 0 0 0 24 24 A5 5 0 0 1 24 14" fill="#0047A0"/>
        <g transform="rotate(-60 24 24)">
          <rect x="6" y="6" width="3" height="12" fill="#000000"/>
          <rect x="11" y="6" width="3" height="12" fill="#000000"/>
        </g>
        <g transform="rotate(60 24 24)">
          <rect x="39" y="6" width="3" height="12" fill="#000000"/>
          <rect x="34" y="6" width="3" height="12" fill="#000000"/>
        </g>
      </template>

      <!-- Poland (horizontal bicolor) -->
      <template v-else-if="getCountryCode(code) === 'pl'">
        <rect width="48" height="24" y="0" fill="#FFFFFF"/>
        <rect width="48" height="24" y="24" fill="#DC143C"/>
      </template>

      <!-- Brazil -->
      <template v-else-if="getCountryCode(code) === 'br'">
        <rect width="48" height="48" fill="#009739"/>
        <polygon points="24,6 44,24 24,42 4,24" fill="#FEDD00"/>
        <circle cx="24" cy="24" r="8" fill="#002776"/>
      </template>

      <!-- Portugal -->
      <template v-else-if="getCountryCode(code) === 'pt'">
        <rect width="18" height="48" x="0" fill="#006600"/>
        <rect width="30" height="48" x="18" fill="#FF0000"/>
        <circle cx="18" cy="24" r="8" fill="#FFCC00"/>
        <circle cx="18" cy="24" r="5" fill="#FF0000"/>
      </template>

      <!-- Russia (horizontal tricolor) -->
      <template v-else-if="getCountryCode(code) === 'ru'">
        <rect width="48" height="16" y="0" fill="#FFFFFF"/>
        <rect width="48" height="16" y="16" fill="#0039A6"/>
        <rect width="48" height="16" y="32" fill="#D52B1E"/>
      </template>

      <!-- Turkey -->
      <template v-else-if="getCountryCode(code) === 'tr'">
        <rect width="48" height="48" fill="#E30A17"/>
        <circle cx="18" cy="24" r="10" fill="#FFFFFF"/>
        <circle cx="21" cy="24" r="8" fill="#E30A17"/>
        <polygon points="30,24 34,26 32,22 36,22 32,20 34,16 30,20 26,16 28,20 24,22 28,22 26,26" fill="#FFFFFF"/>
      </template>

      <!-- China -->
      <template v-else-if="getCountryCode(code) === 'cn'">
        <rect width="48" height="48" fill="#DE2910"/>
        <polygon points="12,8 14,14 10,10 14,10 10,14" fill="#FFDE00" transform="scale(1.5) translate(2,2)"/>
        <circle cx="26" cy="10" r="2" fill="#FFDE00"/>
        <circle cx="30" cy="14" r="2" fill="#FFDE00"/>
        <circle cx="30" cy="20" r="2" fill="#FFDE00"/>
        <circle cx="26" cy="24" r="2" fill="#FFDE00"/>
      </template>

      <!-- Serbia (horizontal tricolor) -->
      <template v-else-if="getCountryCode(code) === 'rs'">
        <rect width="48" height="16" y="0" fill="#C6363C"/>
        <rect width="48" height="16" y="16" fill="#0C4076"/>
        <rect width="48" height="16" y="32" fill="#FFFFFF"/>
        <rect x="8" y="8" width="12" height="16" fill="#FFFFFF"/>
        <rect x="10" y="10" width="8" height="12" fill="#C6363C"/>
      </template>

      <!-- Thailand -->
      <template v-else-if="getCountryCode(code) === 'th'">
        <rect width="48" height="8" y="0" fill="#A51931"/>
        <rect width="48" height="8" y="8" fill="#F4F5F8"/>
        <rect width="48" height="16" y="16" fill="#2D2A4A"/>
        <rect width="48" height="8" y="32" fill="#F4F5F8"/>
        <rect width="48" height="8" y="40" fill="#A51931"/>
      </template>

      <!-- Vietnam -->
      <template v-else-if="getCountryCode(code) === 'vn'">
        <rect width="48" height="48" fill="#DA251D"/>
        <polygon points="24,8 27,18 38,18 29,24 32,34 24,28 16,34 19,24 10,18 21,18" fill="#FFFF00"/>
      </template>

      <!-- Taiwan -->
      <template v-else-if="getCountryCode(code) === 'tw'">
        <rect width="48" height="48" fill="#FE0000"/>
        <rect width="24" height="24" fill="#000095"/>
        <circle cx="12" cy="12" r="6" fill="#FFFFFF"/>
        <circle cx="12" cy="12" r="4" fill="#000095"/>
        <g transform="translate(12,12)">
          <line x1="0" y1="-8" x2="0" y2="8" stroke="#FFFFFF" stroke-width="1"/>
          <line x1="-8" y1="0" x2="8" y2="0" stroke="#FFFFFF" stroke-width="1"/>
          <line x1="-5.7" y1="-5.7" x2="5.7" y2="5.7" stroke="#FFFFFF" stroke-width="1"/>
          <line x1="-5.7" y1="5.7" x2="5.7" y2="-5.7" stroke="#FFFFFF" stroke-width="1"/>
        </g>
      </template>

      <!-- Default fallback -->
      <template v-else>
        <rect width="48" height="48" fill="#CCCCCC"/>
        <text x="24" y="28" text-anchor="middle" fill="#666666" font-size="12" font-weight="bold">{{ code.toUpperCase().substring(0, 2) }}</text>
      </template>
    </g>

    <!-- Circle border -->
    <circle cx="24" cy="24" r="23" fill="none" stroke="currentColor" stroke-opacity="0.2" stroke-width="1"/>
  </svg>
</template>

<style scoped>
.flag-icon {
  display: inline-block;
  vertical-align: middle;
  border-radius: 50%;
  overflow: hidden;
}
</style>

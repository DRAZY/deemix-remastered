import { createRouter, createWebHashHistory } from 'vue-router'

const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {
      path: '/',
      name: 'home',
      component: () => import('./views/HomeView.vue')
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('./views/SearchView.vue')
    },
    {
      path: '/downloads',
      name: 'downloads',
      component: () => import('./views/DownloadsView.vue')
    },
    {
      path: '/favorites',
      name: 'favorites',
      component: () => import('./views/FavoritesView.vue')
    },
    {
      path: '/analyzer',
      name: 'analyzer',
      component: () => import('./views/LinkAnalyzerView.vue')
    },
    {
      path: '/sync',
      name: 'sync',
      component: () => import('./views/SyncView.vue')
    },
    {
      path: '/settings',
      name: 'settings',
      component: () => import('./views/SettingsView.vue')
    },
    {
      path: '/about',
      name: 'about',
      component: () => import('./views/AboutView.vue')
    },
    {
      path: '/artist/:id',
      name: 'artist',
      component: () => import('./views/ArtistView.vue')
    },
    {
      path: '/album/:id',
      name: 'album',
      component: () => import('./views/AlbumView.vue')
    },
    {
      path: '/playlist/:id',
      name: 'playlist',
      component: () => import('./views/PlaylistView.vue')
    },
    {
      path: '/charts',
      name: 'charts',
      component: () => import('./views/ChartsView.vue')
    },
    {
      // Catch-all: redirect unknown routes to home
      path: '/:pathMatch(.*)*',
      redirect: '/'
    }
  ]
})

export default router

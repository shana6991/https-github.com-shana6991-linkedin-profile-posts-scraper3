# LinkedIn Profile Posts Scraper

Scrape le texte complet et les médias (images, vidéos) des posts d’un ou plusieurs profils LinkedIn, via Apify et Puppeteer.

## Fonctionnalités
- Scraping d’un ou plusieurs profils LinkedIn (texte + médias)
- Limitation du nombre de posts par profil (`maxPosts`)
- Compatible Apify Actor (cloud ou local)
- Contournement des blocages LinkedIn (stealth, proxy, cookie)

## Utilisation

### Input (`INPUT_SCHEMA.json`)
- `profileUrls` : URL unique ou liste d’URLs de profils LinkedIn à scraper
- `li_at` : Cookie de session LinkedIn (obligatoire)
- `maxPosts` : Nombre maximum de posts à scraper par profil (défaut : 20)

### Lancer le scraper

```bash
npm install
apify run
```

## Sortie
- Un dataset Apify (JSON) avec pour chaque post : texte, images, vidéos, URL, date

---

**Attention :** Utilisation à des fins personnelles ou de recherche. Respectez les CGU LinkedIn.

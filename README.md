# LinkedIn Profile Posts Scraper

A Node.js scraper that extracts posts from LinkedIn profiles using Puppeteer with stealth mode.

## Features

- Scrapes posts from multiple LinkedIn profiles
- Handles authentication securely
- Uses stealth mode to avoid detection
- Configurable maximum posts limit
- Extracts post text, timestamps, and like counts
- Supports proxy usage (optional)

## Installation

1. Clone this repository
2. Install dependencies:
```bash
npm install
```

## Configuration

Create a `.env` file with your LinkedIn credentials (optional):
```
LINKEDIN_USERNAME=your_email@example.com
LINKEDIN_PASSWORD=your_password
```

## Usage

1. Run the scraper:
```bash
npm start
```

2. Or provide input directly:
```bash
node main.js
```

## Input Schema

The scraper accepts the following input parameters:

- `username` (required): LinkedIn account username/email
- `password` (required): LinkedIn account password
- `profileUrls` (required): Array of LinkedIn profile URLs to scrape
- `maxPosts` (optional): Maximum number of posts to scrape (0 for unlimited)
- `useProxy` (optional): Whether to use a proxy for scraping (default: false)

Example input:
```json
{
    "username": "your_email@example.com",
    "password": "your_password",
    "profileUrls": [
        "https://www.linkedin.com/in/username1",
        "https://www.linkedin.com/in/username2"
    ],
    "maxPosts": 50,
    "useProxy": false
}
```

## Output Format

The scraper outputs an array of posts with the following structure:

```json
{
    "text": "Post content",
    "timestamp": "2024-03-15T10:30:00.000Z",
    "likes": 42,
    "profileUrl": "https://www.linkedin.com/in/username",
    "scrapedAt": "2024-03-15T12:00:00.000Z"
}
```

## Error Handling

- The scraper takes screenshots on errors for debugging
- Failed profile scrapes won't stop the entire process
- Network errors are handled gracefully

## Dependencies

- apify: ^3.1.15
- moment: ^2.29.4
- proxy-chain: ^2.3.0
- puppeteer: ^21.0.0
- puppeteer-extra: ^3.3.6
- puppeteer-extra-plugin-stealth: ^2.11.2

## License

ISC
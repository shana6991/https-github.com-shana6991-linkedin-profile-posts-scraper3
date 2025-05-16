# LinkedIn Profile Posts Scraper

This Apify actor scrapes posts from a specified LinkedIn profile URL.

## Input

The actor requires the following input:

-   **LinkedIn Profile URL**: The URL of the LinkedIn profile to scrape (e.g., `https://www.linkedin.com/in/username/`).
-   **LinkedIn Email**: Your LinkedIn login email.
-   **LinkedIn Password**: Your LinkedIn login password.
-   **Proxy Configuration**: Standard Apify proxy configuration. It\'s recommended to use RESIDENTIAL proxies. The actor will test the provided configuration and attempt fallbacks if it fails.
-   **Maximum Posts to Scrape** (Optional): Maximum number of posts to retrieve. Defaults to 20.
-   **Enable Debug Log** (Optional): Set to true for verbose logging. Defaults to false.

## Output

The actor outputs a dataset containing the scraped posts, including details like post content, likes, comments count, and timestamp.

## Proxy Usage

The actor is designed to use proxies to avoid issues with LinkedIn\'s rate limiting and security measures. It will first attempt to use the proxy configuration provided in the input. If this configuration fails a pre-flight connectivity test, it will attempt to use Apify RESIDENTIAL proxies, then Apify DATACENTER proxies as fallbacks. If all proxy attempts fail, it will try to run without a proxy, which is likely to fail for LinkedIn.

## Authwall Detection

The actor includes basic logic to detect LinkedIn\'s "authwall" (authentication wall). If an authwall is encountered at critical stages (e.g., after login, when accessing a profile), the actor will log the event and may terminate to prevent further issues with the account or IP.

## Disclaimer

Automating LinkedIn interactions may be against their Terms of Service. Use this actor responsibly and at your own risk.
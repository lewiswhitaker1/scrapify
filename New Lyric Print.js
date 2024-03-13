const fetch = require('node-fetch');
const { writeFile, mkdir } = require('fs').promises;
const fs = require('fs');
const path = require('path');

const appPath = path.join(process.env.HOME || process.env.USERPROFILE, "AppData", "Roaming", "scrapify");
const configPath = path.join(appPath, "config.json");
const tokenCachePath = path.join(appPath, '.cache');
const statsPath = path.join(appPath, '.stats');
let CONFIG;

const spotifyTrackURL = process.argv[2];

async function init() {
  CONFIG = await loadConfig();

  if (!spotifyTrackURL || !isValidSpotifyTrackURL(spotifyTrackURL)) {
    console.error(colors.red`Please provide a valid Spotify track URL as an argument.`);
    process.exit(1);
  } else {
    getTrackDetails(spotifyTrackURL).catch(console.error);
  }
}

const defaultConfig = {
  CLIENT_ID: 'YOUR_CLIENT_ID',
  CLIENT_SECRET: 'YOUR_CLIENT_SECRET',
  GENIUS_ACCESS_TOKEN: 'YOUR_GENIUS_ACCESS_TOKEN'
};

async function loadConfig() {
  try {
    if (!fs.existsSync(configPath)) {
      await fs.promises.writeFile(configPath, JSON.stringify(defaultConfig, null, 2));
      console.log('Configuration file created at ' + configPath + '. Please fill in your credentials.');
      process.exit(1);
    }

    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

    if (!config.CLIENT_ID || !config.CLIENT_SECRET || !config.GENIUS_ACCESS_TOKEN) {
      console.log('Please fill in all required credentials in the configuration file at ' + configPath);
      process.exit(1);
    }

    return config;
  } catch (error) {
    console.error('Failed to load configuration:', error);
    process.exit(1);
  }
}

const colors = {
  reset: colorize(0),
  black: colorize(30),
  red: colorize(31),
  green: colorize(32),
  yellow: colorize(33),
  blue: colorize(34),
  magenta: colorize(35),
  cyan: colorize(36),
  white: colorize(37),
  brightBlack: colorize(90),
  brightRed: colorize(91),
  brightGreen: colorize(92),
  brightYellow: colorize(93),
  brightBlue: colorize(94),
  brightMagenta: colorize(95),
  brightCyan: colorize(96),
  brightWhite: colorize(97)
};

async function getAccessToken() {
  await mkdir(path.join(process.env.HOME || process.env.USERPROFILE, "AppData", "Roaming", "scrapify"), { recursive: true });
  try {
    if (fs.existsSync(tokenCachePath)) {
      const tokenData = JSON.parse(fs.readFileSync(tokenCachePath, 'utf8'));
      const { access_token, expires_at } = tokenData;

      if (Date.now() < expires_at) {
        console.log(colors.brightWhite('\nUsing cached access token.\n\nAccess Token: ')
        + colors.brightMagenta(`${access_token}\n`) + colors.brightWhite('Expires at: ')
        + colors.brightMagenta(`${new Date(expires_at).toLocaleString()}`));
        return access_token;
      }
    }

    const authResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': 'Basic ' + Buffer.from(CONFIG.CLIENT_ID + ':' + CONFIG.CLIENT_SECRET).toString('base64')
      },
      body: 'grant_type=client_credentials'
    });

    const authData = await authResponse.json();
    const expires_at = Date.now() + (authData.expires_in * 1000) - 30000;

    fs.writeFileSync(tokenCachePath, JSON.stringify({ access_token: authData.access_token, expires_at }, null, 2));

    console.log(colors.brightWhite(`\nNew access token retrieved and cached\n
Access Token: `) + colors.brightMagenta(`${authData.access_token}\n`) +
colors.brightWhite(`Expires at: `) + colors.brightMagenta(`${new Date(expires_at).toLocaleString()}`));
    await updateStats({ tokens_generated: 1 });
    return authData.access_token;
  } catch (error) {
    console.error(colors.red`Failed to retrieve Spotify access token:`, error);
    throw error;
  }
}

async function getTrackDetails(spotifyTrackURL) {
  const accessToken = await getAccessToken();
  const trackID = spotifyTrackURL.split('track/')[1].split('?')[0];

  const trackResponse = await fetch(`https://api.spotify.com/v1/tracks/${trackID}`, {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + accessToken }
  });

  const trackData = await trackResponse.json();

  const artistNames = trackData.artists.map(artist => artist.name).join(', ');
  console.log(colors.brightWhite`\nGenerating Files For: ` + colors.brightMagenta`${trackData.name} - ${artistNames}\n`);
  const releaseDate = trackData.album.release_date;
  const albumID = trackData.album.uri.split(":").slice(2).join(":");

  const albumResponse = await fetch(`https://api.spotify.com/v1/albums/${albumID}`, {
    method: 'GET',
    headers: { 'Authorization': 'Bearer ' + accessToken }
  });

  const albumData = await albumResponse.json();
  const recordLabel = albumData.label;

  const folderPath = path.join(process.env.HOME || process.env.USERPROFILE, 'Desktop', 'spotify', trackID);
  await mkdir(folderPath, { recursive: true });

  const data = {
    title: trackData.name,
    creator: artistNames,
    release_date: formatDate(releaseDate),
    record_label: recordLabel
  };

  await writeFile(path.join(folderPath, 'data.json'), JSON.stringify(data, null, 2));
  console.log(colors.brightWhite`Successfully wrote track data to ` + colors.brightMagenta`${path.join(folderPath, 'data.json')}`);

  if (trackData.album && trackData.album.images && trackData.album.images.length > 0) {
    const imageUrl = trackData.album.images[0].url;
    await downloadContent(imageUrl, folderPath, 'image.png');
    console.log(colors.brightWhite`Successfully wrote album art to ` + colors.brightMagenta`${path.join(folderPath, 'image.png')}`);
  }

  await downloadContent(`https://scannables.scdn.co/uri/plain/svg/FFFFF/black/1000/spotify:track:${trackID}`, folderPath, 'scannable.svg');
  console.log(colors.brightWhite`Successfully wrote scannable to ` + colors.brightMagenta`${path.join(folderPath, 'scannable.svg')}`);

  await updateStats({ tracks_retrieved: 1 });

  searchGeniusForLyrics(trackData.name, artistNames, folderPath).catch(console.error);
}

async function searchGeniusForLyrics(songTitle, artistName, folderPath) {
  const splitTitle = songTitle.split("(with")[0];
  const encodedTitle = encodeURIComponent(splitTitle);
  const encodedArtist = encodeURIComponent(artistName);
  const apiUrl = `https://api.genius.com/search?q=${encodedTitle}%20${encodedArtist}&access_token=${CONFIG.GENIUS_ACCESS_TOKEN}`;

  const filterWords = ["New Music Friday", "Release Calendar", "traduction", "deutsche", "Español", "Top Artists of", "Top Tracks of", "Highest To Lowest", "This Is", "Annotated", "A Portrait of the Artist as a Young Man",
    "Portrait of the Artist as a Young Man", "Brown v. Entertainment Merchants Association"];

  try {
    const response = await fetch(apiUrl);
    let data;
    try {
      data = await response.json();
    } catch (error) {
      // Handle invalid JSON response
      console.log(colors.red`Genius API didn't return JSON, the API may be down. Writing placeholder lyrics file.`);
      await writeFile(path.join(folderPath, 'lyrics.txt'), "Genius API didn't return JSON, the API may be down");
      throw new Error("Genius API didn't return proper format, please check if it is down");
    }

    const hits = data.response.hits;

    const filteredHits = hits.filter(hit =>
      !filterWords.some(filterWord => hit.result.title_with_featured.toLowerCase().includes(filterWord.toLowerCase()))
    );

    if (filteredHits.length > 0) {
      const sanitizeString = (str) => str.toLowerCase().replace(/[^a-z0-9\s]/gi, '');

      const sanitizedTitleParts = sanitizeString(splitTitle).split(/\s+/);

      const relevantHit = filteredHits.find(hit =>
        sanitizedTitleParts.some(part =>
          sanitizeString(hit.result.url).includes(part)
        )
      );

      if (relevantHit) {
        const songLyricsUrl = relevantHit.result.url;
        scrapeLyrics(songLyricsUrl, folderPath).catch(console.error);
      } else {
        console.log(colors.red`No suitable lyrics found for this song based on title check.`);
        await writeFile(path.join(folderPath, 'lyrics.txt'), "No suitable lyrics found for this song based on title check.");
      }
    } else {
      console.log(colors.red`No suitable lyrics found for this song.`);
      await writeFile(path.join(folderPath, 'lyrics.txt'), "No suitable lyrics found for this song.");
    }
  } catch (error) {
    console.error(colors.red`An error occurred:` + colors.brightRed`${error.message}`);
  }
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function scrapeLyrics(url, folderPath) {
  try {
    const response = await fetch(url);
    const body = await response.text();
    let lyricsMatch = body.match(/<div[^>]+data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/);

    if (lyricsMatch && lyricsMatch[1]) {
      let lyrics = lyricsMatch[1];
      lyrics = lyrics.replace(/<br\s*\/?>/gi, '\n');
      lyrics = lyrics.replace(/<\/?[^>]+(>|$)/g, "");
      lyrics = lyrics.replace(/<script[\s\S]*?<\/script>/gi, "");
      lyrics = lyrics.replace(/\n/g, " ");
      lyrics = lyrics.trim();

      lyrics = decodeHtmlEntities(lyrics);

      lyrics = lyrics.replace(/\[.*?\]/g, '').replace(/ +/g, ' ').trim();
      lyrics = toProperEnglish(lyrics);

      await writeFile(path.join(folderPath, 'lyrics.txt'), lyrics);
      console.log(colors.brightWhite`Successfully wrote lyrics to ` + colors.brightMagenta`${path.join(folderPath, 'lyrics.txt')}`);
    } else {
      console.log(colors.yellow`Could not find the lyrics in the page.`);
      await writeFile(path.join(folderPath, 'lyrics.txt'), "Could not find the lyrics in the page.");
    }
  } catch (error) {
    console.error(colors.red`An error occurred while scraping the lyrics: ${error.message}`);
  }
}

async function updateStats(updateFields) {
  let stats = { tokens_generated: 0, tracks_retrieved: 0 };

  try {
    if (fs.existsSync(statsPath)) {
      stats = JSON.parse(fs.readFileSync(statsPath, 'utf8'));
    }

    Object.keys(updateFields).forEach(key => {
      if (stats.hasOwnProperty(key)) {
        stats[key] += updateFields[key];
      }
    });

    await writeFile(statsPath, JSON.stringify(stats, null, 2));
  } catch (error) {
    console.error(colors.red`Failed to update stats:`, error);
  }
}

async function downloadContent(url, folderPath, fileName) {
  const response = await fetch(url);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  await writeFile(path.join(folderPath, fileName), buffer);
}

function formatDate(dateString) {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const date = new Date(dateString);
  const day = date.getDate();
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  let daySuffix;
  switch (day) {
    case 1: case 21: case 31: daySuffix = "st"; break;
    case 2: case 22: daySuffix = "nd"; break;
    case 3: case 23: daySuffix = "rd"; break;
    default: daySuffix = "th";
  }
  return `${day}${daySuffix} ${month} ${year}`;
}

function isValidSpotifyTrackURL(url) {
  const pattern = /^(https?:\/\/)?(open\.spotify\.com|spotify\.com)\/track\/[a-zA-Z0-9]{22}$/;
  return pattern.test(url);
}

function toProperEnglish(inputString) {
  let lowerCaseString = inputString.toLowerCase();

  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  let sentences = lowerCaseString.split(/(?<=[.!?])\s+/).map(capitalize);

  let capitalizedText = sentences.join(' ');

  const regex = /\bi(?:'m|i'll|i'd|i've|i'ma|'ve|'ll|'d)?\b/g;
  let properEnglishText = capitalizedText.replace(regex, (match) => match.toUpperCase());

  return properEnglishText;
}

function colorize(colorCode) {
  return (...args) => {
    if (Array.isArray(args[0])) {
      const str = args[0].reduce((acc, cur, i) => `${acc}${cur}${args[i + 1] || ''}`, '');
      return `\x1b[${colorCode}m${str}\x1b[0m`;
    } else {
      const message = args.join(' ');
      return `\x1b[${colorCode}m${message}\x1b[0m`;
    }
  };
}

init().catch(console.error);
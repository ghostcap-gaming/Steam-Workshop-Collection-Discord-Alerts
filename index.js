const axios = require('axios');
const fs = require('fs');
const path = require('path');
const URLSearchParams = require('url').URLSearchParams;
const cheerio = require('cheerio');

const API_KEY = 'YOUR-STEAMAPI-KEY';
const COLLECTION_ID = '3070555563';
const INTERVAL = 1 * 60 * 1000; // Check every 1 min
const SCRAPE_INTERVAL = 7000; // 7 seconds delay between scrape requests
const UPDATE_SCRAPE_INTERVAL = 2 * 60 * 60 * 1000; // 6 hours in milliseconds
const webhookUrl = 'https://discord.com/api/webhooks/YOUR-CHANNEL-WEBHOOK';

let isScrapingInProgress = false;

const fetchData = async () => {
    try {
        const params = new URLSearchParams();
        params.append('key', API_KEY);
        params.append('collectioncount', '1');
        params.append('publishedfileids[0]', COLLECTION_ID);

        const response = await axios.post(
            'https://api.steampowered.com/ISteamRemoteStorage/GetCollectionDetails/v1/', 
            params,
            {
                headers: { 
                    'Content-Type': 'application/x-www-form-urlencoded' 
                }
            }
        );

        return response.data;
    } catch (error) {
        console.error('Error fetching data:', error);
        return null;
    }
};

const updateAllMaps = async () => {
    const filePath = path.join(__dirname, 'collection_data.json');
    const scrapedDataPath = path.join(__dirname, 'workshop_items_details.json');
    if (!fs.existsSync(filePath) || !fs.existsSync(scrapedDataPath)) {
        console.log('Initial data not available for update check.');
        return;
    }

    const collectionData = JSON.parse(fs.readFileSync(filePath, 'utf8')).response;
    const existingScrapedData = JSON.parse(fs.readFileSync(scrapedDataPath, 'utf8'));
    const workshopItems = collectionData.collectiondetails[0].children.map(child => child.publishedfileid);

    console.log(`Updating all ${workshopItems.length} workshop items...`);
    const scrapedData = await scrapeWorkshopItems(workshopItems);

    saveData(collectionData, scrapedData, existingScrapedData, []);
};

setInterval(updateAllMaps, UPDATE_SCRAPE_INTERVAL);

const fetchWorkshopItemDetails = async (id) => {
    try {
        console.log(`Fetching details for item ${id}`);
        const url = `https://steamcommunity.com/sharedfiles/filedetails/?id=${id}`;
        const response = await axios.get(url, { timeout: 10000 });
        const $ = cheerio.load(response.data);

        const title = $('.workshopItemTitle').text().trim();
        const imageUrl = $('meta[property="og:image"]').attr('content');

        const fileSize = $('.detailsStatsContainerRight .detailsStatRight').first().text().trim();
        const postedDate = $('.detailsStatsContainerRight .detailsStatRight').eq(1).text().trim();
        const updatedDate = $('.detailsStatsContainerRight .detailsStatRight').eq(2).text().trim();

        return {
            id,
            title,
            fileSize,
            postedDate,
            updatedDate,
            imageUrl
        };
    } catch (error) {
        console.error(`Error fetching details for item ${id}:`, error.message);
        return { id, title: 'Error fetching data', fileSize: null, postedDate: null, updatedDate: null, imageUrl: null };
    }
};

const scrapeWorkshopItems = async (items) => {
    if (isScrapingInProgress) {
        console.log('Scraping already in progress. Skipping new scrape request.');
        return [];
    }

    isScrapingInProgress = true;
    const results = [];
    console.log(`Starting to scrape ${items.length} workshop items`);

    for (const id of items) {
        const result = await fetchWorkshopItemDetails(id);
        results.push(result);
        await new Promise(resolve => setTimeout(resolve, SCRAPE_INTERVAL));
    }

    console.log('Completed scraping workshop items');
    isScrapingInProgress = false;
    return results;
};

const checkForUpdates = async () => {
    const newData = await fetchData();
    if (!newData) return;

    const filePath = path.join(__dirname, 'collection_data.json');
    const workshopItems = newData.response.collectiondetails[0].children.map(child => child.publishedfileid);

    const scrapedDataPath = path.join(__dirname, 'workshop_items_details.json');
    let existingScrapedData = {};
    if (fs.existsSync(scrapedDataPath)) {
        existingScrapedData = JSON.parse(fs.readFileSync(scrapedDataPath, 'utf8'));
    }

    const itemsToUpdate = workshopItems.filter(id => !existingScrapedData.hasOwnProperty(id));
    const removedItemIds = Object.keys(existingScrapedData).filter(id => !workshopItems.includes(id));
    const updatedItemIds = workshopItems.filter(id => {
        const newItem = existingScrapedData[id];
        const existingItem = existingScrapedData[id];
        return newItem && existingItem && (
            newItem.fileSize !== existingItem.fileSize ||
            newItem.postedDate !== existingItem.postedDate ||
            newItem.updatedDate !== existingItem.updatedDate ||
            newItem.imageUrl !== existingItem.imageUrl
        );
    });

    if (fs.existsSync(filePath)) {
        const oldData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (JSON.stringify(oldData.response) !== JSON.stringify(newData.response) || itemsToUpdate.length > 0 || removedItemIds.length > 0 || updatedItemIds.length > 0) {
            console.log(`Collection has been updated. ${itemsToUpdate.length} maps added, ${removedItemIds.length} maps removed, ${updatedItemIds.length} maps updated.`);
            const scrapedData = await scrapeWorkshopItems([...itemsToUpdate, ...updatedItemIds]);

            await sendDiscordNotification(scrapedData, removedItemIds, updatedItemIds, existingScrapedData);

            saveData(newData.response, scrapedData, existingScrapedData, removedItemIds);
        } else {
            console.log('No changes detected');
        }
    } else {
        console.log(`Initial data save. Starting to scrape ${workshopItems.length} workshop items`);
        const scrapedData = await scrapeWorkshopItems(workshopItems);
        saveData(newData.response, scrapedData, existingScrapedData, []);
    }
};

const logChanges = (addedItems, removedItems, existingScrapedData) => {
    const logFilePath = path.join(__dirname, 'update_log.txt');
    const timestamp = new Date().toISOString();

    let logMessage = `[${timestamp}] Update Detected:\n`;

    if (addedItems.length > 0) {
        logMessage += `Added Maps (${addedItems.length}): \n`;
        addedItems.forEach(item => logMessage += ` - ${item.id}: ${item.title}\n`);
    }

    if (removedItems.length > 0) {
        logMessage += `Removed Maps (${removedItems.length}): \n`;
        removedItems.forEach(id => logMessage += ` - ${id}: ${existingScrapedData[id]?.title || 'Unknown Title'}\n`);
    }

    fs.appendFileSync(logFilePath, logMessage);
};

const sendDiscordNotification = async (scrapedData, removedItemIds, updatedItemIds, existingScrapedData) => {

    let allEmbeds = [];

    allEmbeds.push(...scrapedData.filter(item => !existingScrapedData.hasOwnProperty(item.id)).map(item => {
        return {
            title: `Added Map: ${item.title}`,
            url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.id}`,
            image: { url: item.imageUrl },
            fields: [
                { name: 'File Size', value: item.fileSize || 'Unknown', inline: true },
                { name: 'Posted Date', value: item.postedDate || 'Unknown', inline: true },
                { name: 'Updated Date', value: item.updatedDate || 'Unknown', inline: true }
            ],
            color: 3066993
        };
    }));

    allEmbeds.push(...updatedItemIds.map(id => {
        const item = scrapedData.find(i => i.id === id);
        return {
            title: `Updated Map: ${item.title}`,
            url: `https://steamcommunity.com/sharedfiles/filedetails/?id=${item.id}`,
            image: { url: item.imageUrl },
            fields: [
                { name: 'File Size', value: item.fileSize || 'Unknown', inline: true },
                { name: 'Posted Date', value: item.postedDate || 'Unknown', inline: true },
                { name: 'Updated Date', value: item.updatedDate || 'Unknown', inline: true }
            ],
            color: 15844367
        };
    }));

    allEmbeds.push(...removedItemIds.map(id => {
        const item = existingScrapedData[id];
        return {
            title: `Removed Map: ${item.title}`,
            color: 15158332
        };
    }));

    for (const embed of allEmbeds) {
        await sendSingleEmbed(embed);
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
};

const sendSingleEmbed = async (embed) => {
    try {
        await axios.post(webhookUrl, { embeds: [embed] });
        console.log(`Discord notification sent for ${embed.title}`);
    } catch (error) {
        console.error(`Failed to send Discord notification for ${embed.title}:`, error.message);
    }
};

const saveData = (response, scrapedData, existingScrapedData, removedItems) => {
    const responsePath = path.join(__dirname, 'collection_data.json');
    const scrapedDataPath = path.join(__dirname, 'workshop_items_details.json');

    fs.writeFileSync(responsePath, JSON.stringify({ response, lastUpdated: new Date().toISOString() }, null, 2), 'utf8');

    const updatedScrapedData = { ...existingScrapedData };

    scrapedData.forEach(newItem => {
        updatedScrapedData[newItem.id] = newItem;
    });

    removedItems.forEach(id => {
        delete updatedScrapedData[id];
    });

    try {
        console.log('Preparing to write scraped data...');
        const jsonData = JSON.stringify(updatedScrapedData, null, 2);
        console.log('JSON data prepared, writing to file...');
        fs.writeFileSync(scrapedDataPath, jsonData, 'utf8');
        console.log('Data written successfully');
    } catch (error) {
        console.error('Error in saveData function:', error.message);
    }
};

setInterval(checkForUpdates, INTERVAL);
checkForUpdates();
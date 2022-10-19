import * as dotenv from 'dotenv';
import { Telegraf } from 'telegraf';
import got from 'got';
import { parse } from 'node-html-parser';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { uniqBy } from 'lodash-es';
import express from 'express';


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

const db = new Database(join(__dirname, process.env.DB_FILENAME), {verbose: console.log});
const bot = new Telegraf(process.env.BOT_TOKEN);

bot.launch();
bot.start((ctx) => ctx.reply('Welcome'));

const getOffers = async (searchParams) => {
	const res = await got.get('https://www.bazaraki.com/ajax-items-list/', {
		searchParams,
		headers: {
			'x-requested-with': 'XMLHttpRequest',
		},

	}).json();

	const root = parse(res.listing);
	return root.querySelectorAll('[itemtype="http://schema.org/Product"]').map(l => {
		const name = l.querySelector('[itemprop="name"]').text.trim();

		const price = l.querySelector('[itemprop="price"]').getAttribute('content');
		const image = l.querySelector('[itemprop="image"]')?.getAttribute('src') ?? '';
		const url = l.querySelector('[itemprop="name"]').getAttribute('href');
		const date = l.querySelector('.announcement-block__date')?.text.trim().split(',')[0] ?? '';

		return {name, url, date, price, image};
	});
};

/**
 *
 * @param url: string
 * @returns {Promise<Awaited<Array<{date: string|undefined, image: string, price: string, name: string, url: string}>>>}
 */
const getData = async (url) => {
	const res = await got.get(url).text();
	const root = parse(res);
	const rubric = root.querySelector('input[name=rubric]').getAttribute('value');
	const c = root.querySelector('input[name=c]').getAttribute('value');
	const pagination = root.querySelectorAll('[data-page].page-number');
	const pageCount = pagination[pagination.length - 1]?.getAttribute('data-page')??1;
	const ordering = '';
	const q = '';
	const myURL = new URL(url);
	const attrs = myURL.pathname.split('/').filter(p => p.includes('---')).reduce((acc, p) => {
		const s = p.split('---');
		return {...acc, [`attrs__${s[0]}`]: s[1]};
	}, {});
	const filters = Object.fromEntries(myURL.searchParams);

	return (await Promise.all(new Array(pageCount).fill(null).map((_, i) => i + 1).map(page => getOffers({
		rubric, c, page, ordering, q, ...filters, ...attrs,
	})))).flat();
};

db.exec('CREATE TABLE IF NOT EXISTS state (chat_id integer primary key, state CHAR );');
db.exec('CREATE TABLE IF NOT EXISTS shown (chat_id INT, ad CHAR, unique (chat_id, ad) );');
db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INT, 
    url CHAR, 
    unique (chat_id, url) 
);`);

bot.command('list', ctx => {
	const chatId = ctx.chat.id;
	const stmt = db.prepare('SELECT id, chat_id as chatId, url FROM subscriptions WHERE chat_id = @chatId');
	const subscriptions = stmt.all({chatId});
	subscriptions.forEach(s => {

		ctx.reply(s.url, {
			reply_markup: {
				inline_keyboard: [
					[{text: 'Remove', callback_data: `remove_subscription_${s.id}`}],
				],
			},
		});
	});

});

bot.action(/remove_subscription_(\d+)/, async (ctx) => {
	db.prepare('DELETE from subscriptions WHERE id = @id').run({id: ctx.match[1]});

	ctx.reply('Removed subscription!');
	await ctx.answerCbQuery();
});

bot.hears(new RegExp(/https:\/\/(www\.)?bazaraki\.com\/(.*)/i), async (ctx) => {
	const [url] = ctx.match;
	const chatId = ctx.chat.id;
	ctx.reply('Parsing...');

	const allLinks = uniqBy(await getData(url), l => l.url);
	const insert = db.prepare('INSERT OR IGNORE INTO shown (chat_id, ad) VALUES (@chatId, @url)');

	const insertMany = db.transaction((rows) => {
		for (const row of rows) insert.run(row);
	});

	insertMany(allLinks.map(l => ({url: l.url, chatId})));

	db.prepare('INSERT OR IGNORE INTO subscriptions (chat_id, url) VALUES (@chatId, @url)').run({url, chatId});

	ctx.reply('Ads parsed, subscription added');
});

const checkSubscription = async (subscription) => {
	try {

		const {chatId, url} = subscription;
		const links = await getData(url);

		const shownAds = db.prepare('SELECT ad as url FROM shown WHERE chat_id = @chatId').all({chatId}).map(r => r.url);
		const newLinks = links.filter(l => {
			return !shownAds.includes(l.url) && (!l.date || l.date.includes('Today'));
		});
		newLinks.forEach(l => {
			db.prepare('INSERT OR IGNORE INTO shown (chat_id, ad) VALUES (@chatId, @url)').run({url: l.url, chatId});
		});

		if (newLinks.length) {
			newLinks.forEach(link => {
				bot.telegram.sendPhoto(chatId, link.image, {caption: `[${link.name.replace('-', '\\-')}](https://www.bazaraki.com${link.url}), ${link.price.replace('.', '\\.')}€`, parse_mode: "MarkdownV2"})
			});
		}


	} catch (e) {
		console.error(e);
	}
};
const checkAll = () => {
	const stmt = db.prepare('SELECT chat_id as chatId, url FROM subscriptions');
	for (const sub of stmt.all()) {
		checkSubscription(sub);
	}
};

setInterval(checkAll, process.env.POLL_INTERVAL);
checkAll();

// healthcheck

const app = express();

app.get('/healthcheck', (req, res) => {
	res.end(`Hello`);
});
app.listen('8080');

process.on('exit', () => {
	db.close();
});

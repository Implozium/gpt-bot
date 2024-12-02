import { request } from 'node:https';
import fs from 'node:fs';

const apiKey = process.env['API_KEY'];
const botToken = process.env['BOT_TOKEN'];
const folderId = process.env['FOLDER_ID'];

if (!apiKey || !botToken || !folderId) {
    process.exit(1);
}

type Settings = {
    units: string[];
};

const settings: Settings = JSON.parse(fs.readFileSync('./settings.json', 'utf8'));

type FetchOptions = {
    method: 'GET';
    headers?: Record<string, string>;
} | {
    method: 'POST';
    body: Record<string, unknown>;
    headers?: Record<string, string>;
}

async function fetch<T>(url: URL, options: FetchOptions = { method: 'GET' }): Promise<T> {
    return new Promise((res, rej) => {
        const body = options.method === 'POST' ? JSON.stringify(options.body) : '';
        const aRequest = request(url, {
            method: options.method,
            headers: {
                ...options.headers,
                ...(options.method === 'POST' ? {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                } : {}),
            }
        }, (response) => {
            // console.log('response', url, response);
            let text = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => text += String(chunk));
            response.on('end', () => {
                // process.exit(1);
                return res(JSON.parse(text));
            });
        });
        aRequest.on('error', (e) => {
            console.error(`Problem with request: ${e.message}`);
            return rej(e);
        });
        if (options.method === 'POST') {
            aRequest.write(body, 'utf-8');
        }
        aRequest.end();
    });
}

type YAGPTResponse = {
    result: {
        alternatives: {
            message: {
                text: string;
            };
        }[];
    };
};

const units: Set<string> = new Set(settings.units);

async function fetchPortent(): Promise<string> {
    const words: string[] = [];
    const causeWords: string[] = [];
    const localUnits = Array.from(units);
    do {
        words.push(...localUnits.splice(Math.floor(localUnits.length * Math.random()), 1));
    } while (localUnits.length && Math.random() < 0.3)
    do {
        causeWords.push(...localUnits.splice(Math.floor(localUnits.length * Math.random()), 1));
    } while (localUnits.length && Math.random() < 0.2)
    const prediction = `Напиши короткое предсказание для человека где есть ${words.join(', ')} и это из-за того, что у него ${causeWords.join(', ')}. Не используй разметку Markdown! Не упоминай что ты искусственный интеллект! Не добавляй того как помочь!`;

    // console.log('words', words, causeWords, prediction);

    const result = await fetch<YAGPTResponse>(new URL('https://llm.api.cloud.yandex.net/foundationModels/v1/completion'), {
        method: 'POST',
        body: {
            "modelUri": `gpt://${folderId}/yandexgpt-lite`,
            "completionOptions": {
                "stream": false,
                "temperature": 0.6,
                "maxTokens": "200"
            },
            "messages": [
                {
                    "role": "system",
                    "text": "Ты професиональная гадалка и пишешь саркастические предсказания",
                },
                {
                    "role": "user",
                    "text": prediction,
                }
            ]
        },
        headers: {
            'Authorization': `Api-Key ${apiKey}`,
        }
    });

    // console.log(JSON.stringify(result, null, 4));
    return result.result.alternatives[0].message.text;
}

type TelegramBotResponse<T> =
    | {
          ok: true;
          result: T;
      }
    | {
          ok: false;
      };

type TelegramBotUpdate = {
    update_id: number;
    message?: {

    };
    inline_query?: {
        id: string;
        from: {
            id: string;
            is_bot: boolean;
            username?: string;
        };
        query: string;
        offset: string;
    };
}

type TelegramBotInlineAnswer = {
    inline_query_id: string;
    results: {
        type: 'article';
        id: string;
        caption: string;
        title: string;
        input_message_content: {
            message_text: string;
            parse_mode?: 'MarkdownV2';
        }
    }[];
    cache_time: number;
    is_personal: boolean;
};

const TG_URL = 'https://api.telegram.org';

class TelegramBot {
    private token: string;

    private updaters: ((update: TelegramBotUpdate) => void)[] = [];

    constructor(token: string) {
        this.token = token;
    }

    onUpdate(updater: (update: TelegramBotUpdate) => void) {
        this.updaters.push(updater);
    }

    makeMethodUrl(method: string): string {
        return `${TG_URL}/bot${this.token}/${method}`;
    }

    watch(allowedUpdates: string[]): void {
        this.listen(
            this.makeMethodUrl('getUpdates'),
            undefined,
            allowedUpdates,
            (response: TelegramBotResponse<TelegramBotUpdate[]>): number | undefined => {
                try {
                    if (response.ok) {
                        response.result.forEach((update) => {
                            this.updaters.forEach((updater) => updater(update));
                        });

                        const latestUpdateId =
                            response.result[response.result.length - 1]?.update_id;

                        if (latestUpdateId) {
                            const nextUpdateId = latestUpdateId + 1;
                            return nextUpdateId;
                        }
                    }
                } catch (err) {
                    console.error('Caught error', err);
                }

                return undefined;
            },
        );
    }

    private listen(
        url: string,
        offset: number | undefined,
        allowedUpdates: string[],
        onRequest: (response: TelegramBotResponse<TelegramBotUpdate[]>) => number | undefined,
    ): void {
        const fullUrl = new URL(url);
        fullUrl.searchParams.set('offset', offset ? String(offset) : '');
        fullUrl.searchParams.set('limit', '100');
        fullUrl.searchParams.set('timeout', '30');
        fullUrl.searchParams.set('allowed_updates', JSON.stringify(allowedUpdates));

        fetch<TelegramBotResponse<TelegramBotUpdate[]>>(fullUrl, {method: 'GET'})
            .then((response) => {
                const nextOffset = onRequest(response);
                this.listen(url, nextOffset, allowedUpdates, onRequest);
            });
    }

    answerInlineQuery(answer: TelegramBotInlineAnswer): Promise<boolean> {
        return fetch<TelegramBotResponse<TelegramBotUpdate[]>>(new URL(this.makeMethodUrl('answerInlineQuery')), {method: 'POST', body: answer})
            .then((response) => {
                return response.ok;
            });
    }
}

// async function start(): Promise<undefined> {
//     const portent = await fetchPortent();
//     console.log(portent);
// }

const tgbot = new TelegramBot(botToken);

tgbot.onUpdate(async (update) => {
    if (!update.inline_query?.from.username) {
        return;
    }
    const portent = await fetchPortent();
    tgbot.answerInlineQuery({
        inline_query_id: update.inline_query!.id,
        results: [{
            type: 'article',
            id: '0',
            caption: 'Предсказание',
            title: 'Узнай судьбу на день',
            input_message_content: {
                message_text: `Предсказание для @${update.inline_query.from.username}:\n\n${portent}`,
            },
        }],
        cache_time: 300,
        is_personal: true,
    });
});

tgbot.watch(['inline_query']);

// start();

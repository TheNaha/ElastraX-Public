import { WAMessage, proto, getContentType } from '@whiskeysockets/baileys';

const result = getContentType({ conversation: 'hello' });
console.log('result:', result);

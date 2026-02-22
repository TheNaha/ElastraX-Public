import { db } from './src/db';
import { waAuthState } from './src/db/schema';
import { BufferJSON } from '@whiskeysockets/baileys/lib/Utils/generics';

async function test() {
  const data = { test: 123, buf: Buffer.from("hello") };
  const str = JSON.stringify(data, BufferJSON.replacer);

  try {
    await db.insert(waAuthState).values({ id: 'test_creds', data: str })
      .onConflictDoUpdate({
        target: waAuthState.id,
        set: { data: str },
      });
    console.log("Success");
  } catch (e: any) {
    console.log("STACK:");
    console.log(e.stack);
    console.log("MESSAGE:");
    console.log(e.message);
  }
}

test();

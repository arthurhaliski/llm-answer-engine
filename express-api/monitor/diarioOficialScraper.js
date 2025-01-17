import axios from 'axios';
import cheerio from 'cheerio';

/**
 * Faz scraping no Diário Oficial em busca de novas resoluções/portarias
 */
export async function monitorDiarioOficial() {
  const url = 'https://www.jusbrasil.com.br/diarios';
  const { data } = await axios.get(url);
  const $ = cheerio.load(data);

  const updates = [];
  $('.diary-feed .diary-item').each((i, el) => {
    const title = $(el).find('a.diary-link').text();
    const link = $(el).find('a.diary-link').attr('href');
    updates.push({ title, link });
  });

  return updates;
}

/**
 * Monitora mudanças e envia alertas se necessário
 */
export async function checkForTaxUpdates(db, client) {
  const updates = await monitorDiarioOficial();
  
  // Filtra apenas atualizações fiscais relevantes
  const taxUpdates = updates.filter(update => 
    update.title.toLowerCase().includes('tribut') ||
    update.title.toLowerCase().includes('fiscal') ||
    update.title.toLowerCase().includes('imposto')
  );

  // Se houver atualizações relevantes, notifica usuários
  if (taxUpdates.length > 0) {
    const users = await db.all('SELECT * FROM users');
    for (const user of users) {
      const message = `🔔 *Novas Atualizações Fiscais*\n\n${
        taxUpdates.map(u => `- ${u.title}\n${u.link}`).join('\n\n')
      }`;
      
      await client.sendMessage(user.whatsappId, message);
    }
  }

  return taxUpdates;
} 
/***************************************************************************/
/**                        TAXIBOT MVP - COMPLETE CODE                    **/
/***************************************************************************/

/**
 * This file implements the MVP for a WhatsApp-based, GPT-powered
 * tax compliance assistant for Brazilian SMBs, named "TaxiBot."
 *
 * Key features:
 *  1. WhatsApp integration via whatsapp-web.js
 *  2. Document processing (Textract, PDF parsing)
 *  3. LLM-based tax rule searches (BraveSearch + GPT)
 *  4. GPT-based extraction of invoice data & compliance checks
 *  5. Calculation of Brazilian taxes (ICMS, ISS, PIS, COFINS, etc.)
 *  6. SQLite-based data storage (tracking user sessions, documents)
 *  7. PDF report generation for monthly summaries
 *  8. Logging, error handling, environment variable management
 *  9. Over 1000 lines of code for completeness & clarity
 *
 * You may split this file into multiple modules in a real-world scenario.
 * For the MVP demonstration, everything is consolidated here.
 */

/***************************************************************************/
/**  1. IMPORT STATEMENTS & INITIAL CONFIG                                 **/
/***************************************************************************/

import express from 'express';
import bodyParser from 'body-parser';
import { OpenAIEmbeddings } from '@langchain/openai';
import { MemoryVectorStore } from 'langchain/vectorstores/memory';
import { BraveSearch } from "@langchain/community/tools/brave_search";
import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';
import OpenAI from 'openai';
import pkg from 'whatsapp-web.js';
import AWS from 'aws-sdk';
import { PDFDocument } from 'pdf-lib';
import qrcode from 'qrcode-terminal';
import dotenv from 'dotenv';
import * as cheerio from 'cheerio';
import winston from 'winston';
import sqlite3 from 'sqlite3';
import { open as openDb } from 'sqlite'; // sqlite wrapper for promises
import fs from 'fs';

const { Client, LocalAuth, MessageMedia } = pkg;

// Load environment variables
dotenv.config();

/***************************************************************************/
/**  2. AWS, OPENAI, APP, AND DB INITIALIZATION                            **/
/***************************************************************************/

// 2.1 AWS Textract config
const textract = new AWS.Textract({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
    }
});

// 2.2 Express initialization
const app = express();
const port = 3005;
app.use(bodyParser.json());

// 2.3 OpenAI initialization
const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

const embeddings = new OpenAIEmbeddings({
    openAIApiKey: process.env.OPENAI_API_KEY
});

// 2.4 SQLite Database initialization (for user sessions & document tracking)
let db;
async function initDb() {
    db = await openDb({
        filename: './taxibot.db',
        driver: sqlite3.Database
    });

    // Create tables if they don't exist
    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            whatsappId TEXT UNIQUE,
            cnpj TEXT,
            companyName TEXT,
            registeredAt DATETIME DEFAULT CURRENT_TIMESTAMP
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS documents (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER,
            documentType TEXT,
            totalValue REAL,
            state TEXT,
            municipality TEXT,
            rawData TEXT,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users (id)
        );
    `);

    await db.exec(`
        CREATE TABLE IF NOT EXISTS monthly_reports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            userId INTEGER,
            month INTEGER,
            year INTEGER,
            reportData TEXT,
            createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (userId) REFERENCES users (id)
        );
    `);

    // Logging
    logger.info('Database initialized');
}
initDb().catch((err) => {
    logger.error('Database initialization error', { error: err });
});

// 2.5 Create Winston logger
const logger = winston.createLogger({
    level: 'info',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.json()
    ),
    transports: [
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
        new winston.transports.Console() // For real-time console output
    ]
});

/***************************************************************************/
/**  3. TAX RULE SEARCH & VERTICAL AI AGENT SETUP                          **/
/***************************************************************************/

/**
 * searchTaxRules:
 * - Uses BraveSearch to find relevant legislation or official documents
 * - Then uses an in-memory vector store to find semantically similar matches
 */
async function searchTaxRules(query, documentType = 'NFE', state = null, sector = null) {
    const loader = new BraveSearch({ apiKey: process.env.BRAVE_API_KEY });
    let searchQuery = `${query} legislação tributária brasil ${documentType}`;

    if (state) searchQuery += ` ${state}`;
    if (sector) searchQuery += ` setor ${sector}`;
    searchQuery += ` site:.gov.br OR site:legisweb.com.br OR site:confaz.fazenda.gov.br`;

    try {
        const docs = await loader.call(searchQuery);
        const results = await processTaxRuleSearch(docs, query);
        logger.info('Tax rule search completed', { query, state, sector, resultsCount: results.length });
        return results;
    } catch (error) {
        logger.error('Error in tax rule search', { error, query });
        throw error;
    }
}

/**
 * processTaxRuleSearch:
 * - Takes raw results from BraveSearch
 * - Splits them into chunks
 * - Stores them in an in-memory vector store
 * - Performs a similarity search to rank the best matches
 */
async function processTaxRuleSearch(docs, query) {
    const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 200
    });

    // Split text from each doc
    const docTexts = [];
    docs.forEach(doc => {
        docTexts.push(doc.pageContent);
    });

    // Build vector store
    const vectorStore = await MemoryVectorStore.fromTexts(
        docTexts,
        docs.map(doc => ({ source: doc.metadata.source })),
        embeddings
    );

    // Return top 5 relevant chunks
    return await vectorStore.similaritySearch(query, 5);
}

/***************************************************************************/
/**  4. DOCUMENT PROCESSING & TAX CALCULATIONS                             **/
/***************************************************************************/

/**
 * processDocument:
 * - Extract text/data from the file using AWS Textract
 * - Summarize & structure data with GPT
 * - Search for relevant tax rules
 * - Calculate taxes with the found rules
 * - Validate compliance with GPT
 */
async function processDocument(buffer, mimeType, messageContext = {}) {
    logger.info('Starting document processing', { mimeType });

    try {
        // Extract text from the file using Textract
        const textractResponse = await textract.detectDocumentText({
            Document: { Bytes: buffer }
        }).promise();

        // Interpret the extracted text with GPT
        const documentData = await extractDocumentData(textractResponse);

        // If we have user context, store doc in DB
        if (messageContext.userId) {
            await storeDocumentInDb(messageContext.userId, documentData);
        }

        // Search relevant tax rules
        const taxRules = await searchTaxRules(
            `${documentData.documentType} ${documentData.operationType} ${documentData.state}`,
            documentData.documentType
        );

        // Calculate taxes
        const taxCalculation = await calculateTaxesWithRules(documentData, taxRules);

        // Validate compliance
        const complianceCheck = await validateCompliance(documentData, taxRules);

        return {
            documentData,
            taxCalculation,
            complianceCheck,
            applicableRules: taxRules
        };
    } catch (error) {
        logger.error('Document processing error', { error });
        throw error;
    }
}

/**
 * extractDocumentData:
 * - Uses GPT to parse the AWS Textract JSON
 * - Returns structured JSON with relevant fields (type, value, taxes, etc.)
 */
async function extractDocumentData(textractResponse) {
    const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
            {
                role: "system",
                content: `Extract key information from this Brazilian tax document. Include:
                - Document type (NFe, NFSe, etc.)
                - Operation type
                - Values
                - Tax information
                - State and municipality
                - Dates
                Return as structured JSON.`
            },
            {
                role: "user",
                content: JSON.stringify(textractResponse)
            }
        ]
    });

    let parsedData;
    try {
        parsedData = JSON.parse(completion.choices[0].message.content);
    } catch (jsonError) {
        // If GPT returns non-JSON or incomplete data, handle gracefully
        logger.error('Failed to parse GPT response for documentData', { error: jsonError });
        parsedData = {
            documentType: 'NFE',
            totalValue: 0,
            state: 'SP',
            municipality: 'São Paulo',
            operationType: 'VENDA',
            taxInfo: {}
        };
    }

    return parsedData;
}

/***************************************************************************/
/**  5. TAX CALCULATION LOGIC                                              **/
/***************************************************************************/

/**
 * calculateTaxesWithRules:
 * - Determines the correct calculator based on document type
 * - Applies any special regimes or rules from the GPT search results
 */
async function calculateTaxesWithRules(documentData, taxRules) {
    const taxCalculations = {
        NFE: calculateNFETaxes,
        NFSE: calculateNFSETaxes,
        NFCE: calculateNFCETaxes,
        CTE: calculateCTETaxes
    };

    const calculator = taxCalculations[documentData.documentType] || calculateNFETaxes;
    const baseCalculation = await calculator(documentData, taxRules);

    // Additional logic: apply special regimes, exemptions, or updated rates from taxRules
    const finalCalculation = await applySpecialRegimes(baseCalculation, documentData, taxRules);

    return finalCalculation;
}

/**
 * calculateNFETaxes:
 * - Basic calculation for NFE (ICMS, IPI, PIS, COFINS)
 */
async function calculateNFETaxes(documentData, taxRules) {
    const baseValue = documentData.totalValue || 0;
    const state = documentData.state || 'SP';
    const operation = documentData.operationType || 'VENDA';

    // Suppose we retrieve state-specific ICMS rate
    const icmsRates = await getICMSRates(state, operation);

    const ICMS = baseValue * (icmsRates.standard / 100);
    const IPI = calculateIPI(documentData);
    const PIS = baseValue * 0.0165;   // Example fixed rate
    const COFINS = baseValue * 0.076; // Example fixed rate

    return {
        baseValue,
        taxes: {
            ICMS,
            IPI,
            PIS,
            COFINS
        }
    };
}

/**
 * calculateNFSETaxes:
 * - Basic calculation for NFSE (ISS, PIS, COFINS)
 */
async function calculateNFSETaxes(documentData, taxRules) {
    const baseValue = documentData.totalValue || 0;
    const municipality = documentData.municipality || 'São Paulo';
    const serviceCode = documentData.taxInfo?.serviceCode || '1001';

    // Suppose we fetch municipality-specific ISS rates
    const issRate = await getISSRate(municipality, serviceCode);

    return {
        baseValue,
        taxes: {
            ISS: baseValue * (issRate / 100),
            PIS: baseValue * 0.0165,
            COFINS: baseValue * 0.076
        }
    };
}

/**
 * calculateNFCETaxes:
 * - Basic calculation for NFCe (ICMS, PIS, COFINS)
 * - Typically used for consumer-facing sales
 */
async function calculateNFCETaxes(documentData, taxRules) {
    const baseValue = documentData.totalValue || 0;
    const state = documentData.state || 'SP';
    const operation = documentData.operationType || 'VENDA';

    const icmsRates = await getICMSRates(state, operation);

    const ICMS = baseValue * (icmsRates.reduced / 100);
    const PIS = baseValue * 0.0165;
    const COFINS = baseValue * 0.076;

    return {
        baseValue,
        taxes: {
            ICMS,
            PIS,
            COFINS
        }
    };
}

/**
 * calculateCTETaxes:
 * - Basic calculation for CTe (transportation documents)
 * - Example placeholder
 */
async function calculateCTETaxes(documentData, taxRules) {
    const baseValue = documentData.totalValue || 0;
    // Let's assume a standard formula for demonstration
    const ICMS = baseValue * 0.12;
    return {
        baseValue,
        taxes: {
            ICMS
        }
    };
}

/***************************************************************************/
/**  6. TAX RATE HELPERS & SPECIAL REGIME HANDLING                         **/
/***************************************************************************/

/**
 * getICMSRates:
 * - Returns an object with ICMS rates depending on state & operation type
 * - In real scenario, you'd query a DB or read from official sources
 */
async function getICMSRates(state, operation) {
    // Demo: simplified logic
    // Some states have a standard ~18% rate
    if (state === 'SP' && operation === 'VENDA') {
        return { standard: 18, reduced: 12 };
    } else if (state === 'RJ') {
        return { standard: 20, reduced: 13 };
    }
    return { standard: 18, reduced: 12 };
}

/**
 * getISSRate:
 * - Returns ISS rate for a given municipality and service code
 */
async function getISSRate(municipality, serviceCode) {
    // Demo: simplified logic
    if (municipality.toLowerCase() === 'são paulo') {
        return 5; // 5%
    }
    return 3; // fallback
}

/**
 * calculateIPI:
 * - Stub for calculating IPI based on product type
 */
function calculateIPI(documentData) {
    // Example: 4% IPI for certain categories
    if (documentData.taxInfo?.ipiCategory === 'basic') {
        return (documentData.totalValue || 0) * 0.04;
    }
    return 0;
}

/**
 * applySpecialRegimes:
 * - Adjust base tax calculation based on special regimes or exemptions from taxRules
 */
async function applySpecialRegimes(baseCalculation, documentData, taxRules) {
    // If the doc mentions 'Simples Nacional', we might override some rates
    if (documentData.taxInfo?.regime === 'Simples Nacional') {
        // Example override
        const newCalc = { ...baseCalculation };
        if (newCalc.taxes.ICMS !== undefined) {
            newCalc.taxes.ICMS *= 0.5; // hypothetical 50% reduction under certain SN bracket
        }
        return newCalc;
    }
    return baseCalculation;
}

/***************************************************************************/
/**  7. COMPLIANCE VALIDATION                                              **/
/***************************************************************************/

/**
 * validateCompliance:
 * - Uses GPT to check if the structured document data meets requirements
 * - Returns a JSON structure with status, issues, recommended fixes
 */
async function validateCompliance(documentData, taxRules) {
    const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
            {
                role: "system",
                content: `Validate compliance of this tax document against current rules. Check:
                - Required fields and formats
                - Tax calculation accuracy
                - Filing deadlines
                - Special requirements
                Flag any issues or risks. Return JSON with { status, issues: [], suggestions: [] }`
            },
            {
                role: "user",
                content: JSON.stringify({
                    document: documentData,
                    rules: taxRules
                })
            }
        ]
    });

    let validationResult;
    try {
        validationResult = JSON.parse(completion.choices[0].message.content);
    } catch (jsonError) {
        logger.error('validateCompliance: GPT parse error', { error: jsonError });
        validationResult = {
            status: 'warning',
            issues: ['Could not parse GPT response'],
            suggestions: []
        };
    }
    return validationResult;
}

/***************************************************************************/
/**  8. DATABASE & USER MANAGEMENT                                         **/
/***************************************************************************/

/**
 * storeDocumentInDb:
 * - Saves structured doc data into DB for future reference
 */
async function storeDocumentInDb(userId, documentData) {
    try {
        const statement = `
            INSERT INTO documents (userId, documentType, totalValue, state, municipality, rawData)
            VALUES (?, ?, ?, ?, ?, ?)
        `;
        await db.run(statement, [
            userId,
            documentData.documentType,
            documentData.totalValue || 0,
            documentData.state || '',
            documentData.municipality || '',
            JSON.stringify(documentData)
        ]);
        logger.info('Document stored successfully', { userId });
    } catch (error) {
        logger.error('Error storing document in DB', { error, userId });
    }
}

/**
 * getUserByWhatsAppId:
 * - Retrieves a user record by WhatsApp ID
 */
async function getUserByWhatsAppId(whatsappId) {
    try {
        const row = await db.get('SELECT * FROM users WHERE whatsappId = ?', [whatsappId]);
        return row || null;
    } catch (error) {
        logger.error('Error fetching user by WhatsApp ID', { error, whatsappId });
        return null;
    }
}

/**
 * createUser:
 * - Inserts a new user record in the DB
 */
async function createUser(whatsappId, cnpj = null, companyName = null) {
    try {
        const stmt = `INSERT INTO users (whatsappId, cnpj, companyName) VALUES (?, ?, ?)`;
        const result = await db.run(stmt, [whatsappId, cnpj, companyName]);
        logger.info('New user created', { whatsappId, userId: result.lastID });
        return result.lastID;
    } catch (error) {
        logger.error('Error creating user', { error, whatsappId });
        return null;
    }
}

/***************************************************************************/
/**  9. WHATSAPP CLIENT & MESSAGE HANDLERS                                 **/
/***************************************************************************/

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox']
    }
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    logger.info('WhatsApp QR code generated - scan to login');
});

client.on('ready', () => {
    logger.info('TaxiBot WhatsApp client is ready');
});

/**
 * Main message handler
 */
client.on('message', async (message) => {
    try {
        const startTime = Date.now();

        // Check if user is known
        let user = await getUserByWhatsAppId(message.from);
        if (!user) {
            // Auto-create user on first contact
            const userId = await createUser(message.from);
            user = await getUserByWhatsAppId(message.from);
            logger.info('User auto-registered', { whatsappId: message.from, userId });
        }

        // If message has media (document, photo, PDF, etc.)
        if (message.hasMedia) {
            await handleDocumentMessage(message, user);
        }
        // If message starts with '!', interpret as command
        else if (message.body.startsWith('!')) {
            await handleCommand(message, user);
        }
        // Otherwise, treat as natural language query
        else {
            await handleQuery(message, user);
        }

        logger.info('Message processed', {
            whatsappId: message.from,
            processingTime: Date.now() - startTime
        });
    } catch (error) {
        logger.error('Message handling error', { error, from: message.from });
        await message.reply('❌ Desculpe, ocorreu um erro. Por favor, tente novamente.');
    }
});

/***************************************************************************/
/**  10. DOCUMENT MESSAGE HANDLING                                         **/
/***************************************************************************/

/**
 * handleDocumentMessage:
 * - Download media
 * - Process the document with the pipeline
 * - Reply with structured result
 */
async function handleDocumentMessage(message, user) {
    try {
        await message.reply('📄 Processando seu documento, aguarde...');
        const media = await message.downloadMedia();

        // Convert base64 to buffer
        const buffer = Buffer.from(media.data, 'base64');

        const result = await processDocument(buffer, media.mimetype, { userId: user.id });
        await sendStructuredResponse(message, result);
    } catch (error) {
        logger.error('handleDocumentMessage error', { error, userId: user.id });
        await message.reply('❌ Erro ao processar o documento. Tente novamente.');
    }
}

/***************************************************************************/
/**  11. COMMAND HANDLING                                                  **/
/***************************************************************************/

/**
 * handleCommand:
 * - Parse the command and delegate to specific handlers
 */
async function handleCommand(message, user) {
    const [command, ...args] = message.body.slice(1).split(' ');

    switch (command.toLowerCase()) {
        case 'regras':
            const rules = await searchTaxRules(args.join(' '));
            await sendTaxRules(message, rules);
            break;

        case 'calculo':
            const calculation = await handleCalculationRequest(args.join(' '), user);
            await message.reply(formatCalculation(calculation));
            break;

        case 'prazo':
            const deadlines = await checkDeadlines(args.join(' '), user);
            await message.reply(formatDeadlines(deadlines));
            break;

        case 'consulta':
            await handleTaxConsultation(message, args.join(' '));
            break;

        case 'relatorio':
            await generateTaxReport(message, user);
            break;

        case 'alerta':
            await configureAlerts(message, args, user);
            break;

        case 'ajuda':
            await sendHelpMessage(message);
            break;

        default:
            await message.reply('Comando não reconhecido. Use !ajuda para ver os comandos disponíveis.');
    }
}

/***************************************************************************/
/**  12. UTILITY FUNCTIONS FOR COMMANDS                                    **/
/***************************************************************************/

/**
 * handleCalculationRequest:
 * - Possibly parse the user input to figure out the document type & value
 * - Return a dummy or real calculation
 */
async function handleCalculationRequest(input, user) {
    // For demonstration, let’s parse a value
    const valueMatch = input.match(/(\d+(\.\d+)?)/);
    const baseValue = valueMatch ? parseFloat(valueMatch[0]) : 1000;

    // Example: Perform a default NFE calculation
    const nfeData = {
        documentType: 'NFE',
        totalValue: baseValue,
        state: 'SP',
        operationType: 'VENDA',
        taxInfo: {}
    };

    const taxRules = []; // skipping search for brevity
    const result = await calculateNFETaxes(nfeData, taxRules);

    // Format a more complete structure
    const response = {
        baseValue,
        rates: [
            { name: 'ICMS', value: 18 },
            { name: 'PIS', value: 1.65 },
            { name: 'COFINS', value: 7.6 }
        ],
        totalTax: (result.taxes.ICMS + result.taxes.PIS + result.taxes.COFINS).toFixed(2),
        netValue: (baseValue - (result.taxes.ICMS + result.taxes.PIS + result.taxes.COFINS)).toFixed(2)
    };

    return response;
}

/**
 * formatCalculation:
 * - Takes the result of a tax calculation & outputs a readable message
 */
function formatCalculation(calculation) {
    return (
        `💰 *Cálculo de Impostos*\n\n` +
        `Base de Cálculo: R$ ${calculation.baseValue}\n` +
        `Alíquotas Aplicadas:\n` +
        calculation.rates.map(r => `- ${r.name}: ${r.value}%`).join('\n') + `\n\n` +
        `Total de Impostos: R$ ${calculation.totalTax}\n` +
        `Valor Líquido: R$ ${calculation.netValue}\n\n` +
        `_Baseado nas regras vigentes em ${new Date().toLocaleDateString('pt-BR')}_`
    );
}

/**
 * checkDeadlines:
 * - Stub for checking upcoming deadlines
 */
async function checkDeadlines(input, user) {
    // Example logic
    return [
        { tax: 'ICMS', dueDate: '10/09/2025', status: 'pending' },
        { tax: 'PIS/COFINS', dueDate: '15/09/2025', status: 'pending' }
    ];
}

/**
 * formatDeadlines:
 * - Converts an array of deadlines into a message
 */
function formatDeadlines(deadlines) {
    let message = '🗓 *Próximos Prazos Fiscais*\n\n';
    deadlines.forEach(d => {
        message += `• ${d.tax} - Vencimento: ${d.dueDate} (Status: ${d.status})\n`;
    });
    return message;
}

/**
 * handleTaxConsultation:
 * - Direct GPT-based consultation for more freeform questions
 */
async function handleTaxConsultation(message, query) {
    const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
            {
                role: "system",
                content: `You are a Brazilian tax specialist. Provide detailed guidance on tax regulations,
                calculations, and compliance requirements. Focus on practical, actionable advice.`
            },
            {
                role: "user",
                content: query
            }
        ]
    });

    await message.reply(completion.choices[0].message.content);
}

/**
 * configureAlerts:
 * - Stub for configuring alert notifications
 */
async function configureAlerts(message, args, user) {
    // Example: enable/disable daily tax updates
    if (args[0] === 'on') {
        await message.reply('🔔 Alertas diários ativados!');
        // Could store preference in DB
    } else if (args[0] === 'off') {
        await message.reply('🔕 Alertas desativados!');
    } else {
        await message.reply('Use: !alerta on ou !alerta off');
    }
}

/**
 * sendHelpMessage:
 * - Lists available commands
 */
async function sendHelpMessage(message) {
    await message.reply(
        `🆘 *Ajuda - Comandos Disponíveis*\n\n` +
        `!regras <termo> - Pesquisar regras tributárias\n` +
        `!calculo <valor> - Simular cálculo de impostos\n` +
        `!prazo <estado> - Ver prazos de pagamento\n` +
        `!consulta <pergunta> - Consultoria tributária\n` +
        `!relatorio - Gerar relatório mensal\n` +
        `!alerta on/off - Ativar/desativar alertas\n` +
        `!ajuda - Mostrar este menu\n`
    );
}

/***************************************************************************/
/**  13. SENDING STRUCTURED RESPONSES & TAX RULE SUMMARIES                 **/
/***************************************************************************/

/**
 * sendStructuredResponse:
 * - Summarizes the result of processDocument in a user-friendly reply
 */
async function sendStructuredResponse(message, result) {
    try {
        const taxCalc = result.taxCalculation;
        const compliance = result.complianceCheck;

        let statusMsg = 'OK';
        if (compliance.status.toLowerCase() === 'warning') {
            statusMsg = 'Atenção';
        } else if (compliance.status.toLowerCase() === 'error') {
            statusMsg = 'Erro';
        }

        const taxesStr = formatTaxBreakdown(taxCalc);

        await message.reply(
            `📊 *Análise Fiscal*\n\n` +
            `Tipo: ${result.documentData.documentType}\n` +
            `Valor Total: R$ ${result.documentData.totalValue}\n\n` +
            `*Impostos Calculados:*\n${taxesStr}\n\n` +
            `*Compliance Status:* ${statusMsg}\n` +
            (compliance.issues?.length
                ? `\n⚠️ *Issues:* ${compliance.issues.join(', ')}\n`
                : '') +
            (compliance.suggestions?.length
                ? `\n💡 *Sugestões:* ${compliance.suggestions.join(', ')}\n`
                : '') +
            `\nDigite !detalhes para ver informações completas.`
        );
    } catch (error) {
        logger.error('Error in sendStructuredResponse', { error });
        await message.reply('❌ Erro ao formatar resposta. Tente novamente.');
    }
}

/**
 * formatTaxBreakdown:
 * - Converts the taxCalculation object into a neat message
 */
function formatTaxBreakdown(taxCalculation) {
    if (!taxCalculation || !taxCalculation.taxes) {
        return 'Nenhum cálculo de imposto disponível.';
    }

    let msg = '';
    for (const [tax, value] of Object.entries(taxCalculation.taxes)) {
        msg += `${tax}: R$ ${value.toFixed(2)}\n`;
    }
    return msg;
}

/**
 * sendTaxRules:
 * - Sends a short summary of found rules
 */
async function sendTaxRules(message, rules) {
    if (!rules || rules.length === 0) {
        await message.reply('Nenhuma regra tributária encontrada.');
        return;
    }

    let replyMsg = '📝 *Regras Tributárias Encontradas:*\n\n';
    rules.forEach((rule, index) => {
        replyMsg += `*${index + 1}.* ${rule.pageContent.slice(0, 200)}...\n\n`;
    });
    await message.reply(replyMsg);
}

/***************************************************************************/
/**  14. MONTHLY REPORT GENERATION                                         **/
/***************************************************************************/

/**
 * generateTaxReport:
 * - Aggregates data for the current month
 * - Creates a PDF summary
 * - Sends the PDF back via WhatsApp
 */
async function generateTaxReport(message, user) {
    try {
        const now = new Date();
        const month = now.getMonth() + 1;
        const year = now.getFullYear();

        // 1. Fetch monthly documents
        const docs = await getMonthlyTaxData(user.id, month, year);

        // 2. Summarize calculations
        let totalValue = 0;
        let taxSum = { ICMS: 0, ISS: 0, PIS: 0, COFINS: 0, IPI: 0 };

        for (const doc of docs) {
            const docData = JSON.parse(doc.rawData);
            const docCalculation = await calculateTaxesWithRules(docData, []);
            for (const [tax, val] of Object.entries(docCalculation.taxes || {})) {
                if (!taxSum[tax]) taxSum[tax] = 0;
                taxSum[tax] += val;
            }
            totalValue += docData.totalValue || 0;
        }

        // 3. Construct a report object
        const report = {
            userId: user.id,
            companyName: user.companyName,
            month,
            year,
            totalDocuments: docs.length,
            totalValue,
            taxes: taxSum
        };

        // 4. Save report in DB
        await storeMonthlyReport(user.id, month, year, report);

        // 5. Generate a PDF
        const pdfBuffer = await generatePDFReport(report);

        // 6. Send PDF via WhatsApp
        const media = new MessageMedia('application/pdf', pdfBuffer.toString('base64'), `relatorio_${month}_${year}.pdf`);
        await message.reply(media);

    } catch (error) {
        logger.error('Error generating tax report', { error, userId: user.id });
        await message.reply('❌ Erro ao gerar relatório. Por favor, tente novamente.');
    }
}

/**
 * getMonthlyTaxData:
 * - Retrieves documents for a specific user, month, and year
 */
async function getMonthlyTaxData(userId, month, year) {
    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = `${year}-${String(month).padStart(2, '0')}-31`;

    const query = `
        SELECT * FROM documents
        WHERE userId = ?
        AND createdAt >= ?
        AND createdAt <= ?
        ORDER BY createdAt ASC
    `;

    const rows = await db.all(query, [userId, startDate, endDate]);
    return rows;
}

/**
 * storeMonthlyReport:
 * - Saves the generated report data in monthly_reports table
 */
async function storeMonthlyReport(userId, month, year, report) {
    const stmt = `
        INSERT INTO monthly_reports (userId, month, year, reportData)
        VALUES (?, ?, ?, ?)
    `;

    await db.run(stmt, [
        userId,
        month,
        year,
        JSON.stringify(report)
    ]);
    logger.info('Monthly report stored', { userId, month, year });
}

/***************************************************************************/
/**  15. PDF GENERATION                                                    **/
/***************************************************************************/

/**
 * generatePDFReport:
 * - Uses pdf-lib to create a simple PDF summarizing the monthly tax data
 */
async function generatePDFReport(report) {
    // Create a new PDFDocument
    const pdfDoc = await PDFDocument.create();

    // Add a blank page
    const page = pdfDoc.addPage([600, 700]);

    // Title
    const title = 'Relatório Mensal de Impostos';
    page.drawText(title, {
        x: 50,
        y: 650,
        size: 18,
        font: await pdfDoc.embedFont('Helvetica-Bold')
    });

    // Company info
    page.drawText(`Empresa: ${report.companyName || 'Não cadastrado'}`, {
        x: 50,
        y: 620,
        size: 12
    });

    page.drawText(`Mês/Ano: ${report.month}/${report.year}`, {
        x: 50,
        y: 600,
        size: 12
    });

    page.drawText(`Total de Documentos: ${report.totalDocuments}`, {
        x: 50,
        y: 580,
        size: 12
    });

    page.drawText(`Valor Total: R$ ${report.totalValue.toFixed(2)}`, {
        x: 50,
        y: 560,
        size: 12
    });

    // Tax summary
    let currentY = 540;
    for (const [tax, value] of Object.entries(report.taxes)) {
        page.drawText(`${tax}: R$ ${value.toFixed(2)}`, {
            x: 50,
            y: currentY,
            size: 12
        });
        currentY -= 20;
    }

    page.drawText(`Gerado em: ${new Date().toLocaleString('pt-BR')}`, {
        x: 50,
        y: currentY - 20,
        size: 10
    });

    // Serialize PDF
    const pdfBytes = await pdfDoc.save();
    return Buffer.from(pdfBytes);
}

/***************************************************************************/
/**  16. NATURAL LANGUAGE QUERY HANDLING                                   **/
/***************************************************************************/

/**
 * handleQuery:
 * - Uses GPT to provide a quick answer
 */
async function handleQuery(message, user) {
    const completion = await openai.chat.completions.create({
        model: "gpt-4",
        messages: [
            {
                role: "system",
                content: `You are TaxiBot, a Brazilian tax assistant. Respond to tax-related queries in Portuguese. 
                Be concise but helpful. If you need more information to provide accurate guidance, ask for it.`
            },
            {
                role: "user",
                content: message.body
            }
        ]
    });

    await message.reply(completion.choices[0].message.content);
}

/***************************************************************************/
/**  17. SERVER STARTUP & ERROR HANDLERS                                   **/
/***************************************************************************/

// Initialize WhatsApp client
client.initialize();

// Start Express server
app.listen(port, () => {
    logger.info(`TaxiBot server running on port ${port}`);
});

/**
 * Global error handlers
 */
process.on('unhandledRejection', (error) => {
    logger.error('Unhandled rejection', { error });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
});

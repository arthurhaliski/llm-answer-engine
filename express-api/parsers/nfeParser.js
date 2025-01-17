import xml2js from 'xml2js';
import { validateNFeWithSEFAZ } from '../integrations/govApis.js';

/**
 * Parse NFe XML data
 */
export async function parseNFeXML(xmlString) {
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(xmlString);

  // Extraia dados relevantes
  const nfe = result?.nfeProc?.NFe?.infNFe || {};
  const chaveAcesso = result?.nfeProc?.protNFe?.infProt?.chNFe;

  return {
    documentType: 'NFE',
    chaveAcesso,
    totalValue: parseFloat(nfe?.total?.ICMSTot?.vNF || 0),
    state: nfe?.dest?.enderDest?.UF,
    emitente: {
      cnpj: nfe?.emit?.CNPJ,
      nome: nfe?.emit?.xNome,
      ie: nfe?.emit?.IE
    },
    destinatario: {
      cnpj: nfe?.dest?.CNPJ,
      nome: nfe?.dest?.xNome,
      ie: nfe?.dest?.IE
    },
    items: parseNFeItems(nfe?.det),
    impostos: {
      icms: parseFloat(nfe?.total?.ICMSTot?.vICMS || 0),
      ipi: parseFloat(nfe?.total?.ICMSTot?.vIPI || 0),
      pis: parseFloat(nfe?.total?.ICMSTot?.vPIS || 0),
      cofins: parseFloat(nfe?.total?.ICMSTot?.vCOFINS || 0)
    }
  };
}

/**
 * Parse items from NFe
 */
function parseNFeItems(det) {
  if (!det) return [];
  
  // Se det não for array, converte para array
  const items = Array.isArray(det) ? det : [det];
  
  return items.map(item => ({
    codigo: item.prod.cProd,
    descricao: item.prod.xProd,
    quantidade: parseFloat(item.prod.qCom),
    valorUnitario: parseFloat(item.prod.vUnCom),
    valorTotal: parseFloat(item.prod.vProd),
    ncm: item.prod.NCM
  }));
}

/**
 * Validate NFe structure and with SEFAZ
 */
export async function validateNFeStructure(nfeData) {
  // Validação básica de estrutura
  if (!nfeData.chaveAcesso) {
    throw new Error('NFe sem chave de acesso válida');
  }
  
  if (!nfeData.emitente?.cnpj) {
    throw new Error('NFe sem CNPJ do emitente');
  }
  
  if (!nfeData.totalValue || nfeData.totalValue <= 0) {
    throw new Error('NFe com valor total inválido');
  }

  // Validação com SEFAZ
  const sefazResult = await validateNFeWithSEFAZ(nfeData.chaveAcesso);
  return sefazResult;
}

/**
 * Parse NFCe XML data (similar to NFe but with some differences)
 */
export async function parseNFCeXML(xmlString) {
  const parser = new xml2js.Parser({ explicitArray: false });
  const result = await parser.parseStringPromise(xmlString);

  const nfce = result?.nfeProc?.NFe?.infNFe || {};
  const chaveAcesso = result?.nfeProc?.protNFe?.infProt?.chNFe;

  return {
    documentType: 'NFCE',
    chaveAcesso,
    totalValue: parseFloat(nfce?.total?.ICMSTot?.vNF || 0),
    state: nfce?.emit?.enderEmit?.UF,
    emitente: {
      cnpj: nfce?.emit?.CNPJ,
      nome: nfce?.emit?.xNome
    },
    items: parseNFeItems(nfce?.det),
    impostos: {
      icms: parseFloat(nfce?.total?.ICMSTot?.vICMS || 0),
      pis: parseFloat(nfce?.total?.ICMSTot?.vPIS || 0),
      cofins: parseFloat(nfce?.total?.ICMSTot?.vCOFINS || 0)
    }
  };
} 
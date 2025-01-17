import { validateCNPJ, checkSINTEGRA } from '../integrations/govApis.js';

/**
 * Monitora obrigações acessórias e prazos
 */
export async function monitorComplianceObligations(user, db) {
  const now = new Date();
  const month = now.getMonth() + 1;
  const year = now.getFullYear();

  // Verifica documentos do mês
  const docs = await getMonthlyTaxData(user.id, month, year, db);
  const warnings = [];

  // Verifica limite do Simples Nacional
  const yearlyRevenue = await calculateYearlyRevenue(user.id, year, db);
  if (yearlyRevenue > 3600000) {
    warnings.push({
      type: 'SIMPLES_NACIONAL',
      message: 'Possível desenquadramento do Simples Nacional por excesso de faturamento.',
      severity: 'high'
    });
  }

  // Verifica prazos de obrigações acessórias
  const obligations = await checkObligationDeadlines(user, month, year);
  warnings.push(...obligations);

  // Se houver warnings, salva no banco e notifica
  if (warnings.length > 0) {
    await saveComplianceWarnings(user.id, warnings, db);
    return warnings;
  }

  return [];
}

/**
 * Calcula receita anual
 */
async function calculateYearlyRevenue(userId, year, db) {
  const query = `
    SELECT SUM(totalValue) as total
    FROM documents
    WHERE userId = ?
    AND strftime('%Y', createdAt) = ?
  `;
  
  const result = await db.get(query, [userId, year.toString()]);
  return result?.total || 0;
}

/**
 * Verifica prazos de obrigações acessórias
 */
async function checkObligationDeadlines(user, month, year) {
  const warnings = [];
  const now = new Date();

  // Lista de obrigações e seus prazos
  const obligations = [
    { name: 'SPED ECD', day: 31, month: 5 },
    { name: 'SPED ECF', day: 31, month: 7 },
    { name: 'DCTF', day: 15 },  // Mensal
    { name: 'GISS', day: 10 },  // Mensal
    { name: 'ICMS ST', day: 10 } // Mensal
  ];

  for (const obl of obligations) {
    const dueDate = new Date(year, obl.month ? obl.month - 1 : month - 1, obl.day);
    const daysUntilDue = Math.ceil((dueDate - now) / (1000 * 60 * 60 * 24));

    if (daysUntilDue <= 7 && daysUntilDue > 0) {
      warnings.push({
        type: 'DEADLINE',
        obligation: obl.name,
        dueDate: dueDate.toISOString(),
        message: `${obl.name} vence em ${daysUntilDue} dias`,
        severity: daysUntilDue <= 3 ? 'high' : 'medium'
      });
    }
  }

  return warnings;
}

/**
 * Salva warnings no banco de dados
 */
async function saveComplianceWarnings(userId, warnings, db) {
  const stmt = `
    INSERT INTO compliance_warnings (userId, type, message, severity, createdAt)
    VALUES (?, ?, ?, ?, datetime('now'))
  `;

  for (const warning of warnings) {
    await db.run(stmt, [
      userId,
      warning.type,
      warning.message,
      warning.severity
    ]);
  }
}

/**
 * Busca documentos do mês
 */
async function getMonthlyTaxData(userId, month, year, db) {
  const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
  const endDate = `${year}-${String(month).padStart(2, '0')}-31`;

  const query = `
    SELECT * FROM documents
    WHERE userId = ?
    AND createdAt >= ?
    AND createdAt <= ?
    ORDER BY createdAt ASC
  `;

  return await db.all(query, [userId, startDate, endDate]);
}

/**
 * Verifica status de compliance do usuário
 */
export async function checkUserCompliance(user) {
  const checks = [];

  // Verifica CNPJ
  try {
    const cnpjStatus = await validateCNPJ(user.cnpj);
    checks.push({
      type: 'CNPJ',
      status: 'ok',
      message: 'CNPJ válido e ativo'
    });
  } catch (error) {
    checks.push({
      type: 'CNPJ',
      status: 'error',
      message: 'CNPJ com irregularidades'
    });
  }

  // Verifica Inscrição Estadual
  if (user.inscricaoEstadual) {
    try {
      const ieStatus = await checkSINTEGRA(user.inscricaoEstadual);
      checks.push({
        type: 'IE',
        status: 'ok',
        message: 'Inscrição Estadual regular'
      });
    } catch (error) {
      checks.push({
        type: 'IE',
        status: 'error',
        message: 'Inscrição Estadual com pendências'
      });
    }
  }

  return checks;
} 
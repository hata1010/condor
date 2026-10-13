// ============================================================
// SERVICIO — ASISTENTE IA (chat de texto)
// Responde preguntas del admin sobre el condominio.
// Modelo: openai/gpt-oss-120b
// ============================================================

function procesarConsultaUsuario(pregunta) {
  try {
    const contexto = construirContextoAsistente_(pregunta);
    return consultarGroqTexto_(contexto, pregunta);
  } catch (e) {
    Logger.log("Error asistente: " + e.message);
    return "Ocurrió un error al procesar tu consulta: " + e.message;
  }
}

function construirContextoAsistente_(pregunta) {
  const p = pregunta.toLowerCase();
  const conds = RepoCondominios.listarTodos();
  if (!conds.length) return "Sin condominio configurado.";
  const cond = conds[0];

  if (p.match(/deud|mora|pendiente|debe/)) return resumenDeudoresAsistente_(cond.id);
  if (p.match(/egreso|gasto|compra|proveedor/)) return resumenEgresosAsistente_(cond.id);
  if (p.match(/ingreso|dep[oó]sito|pago|recaud/)) return resumenIngresosAsistente_(cond.id);
  if (p.match(/apartamento|inmueble|propietario|edificio|al[ií]cuota/)) return resumenInmueblesAsistente_(cond.id);
  if (p.match(/fondo|saldo/)) return resumenFondosAsistente_(cond.id);

  // Sin coincidencia: resumen general
  return resumenGeneralAsistente_(cond);
}

function resumenGeneralAsistente_(cond) {
  const inmuebles = RepoInmuebles.listarConEdificio(cond.id);
  const saldoOpe = RepoFondoOperativo.saldo(cond.id);
  const saldoRes = RepoFondoReserva.saldo(cond.id);
  const periodo = RepoPeriodosFiscales.abiertoPorCondominio(cond.id);

  let txt = "=== CONDOMINIO: " + cond.nombre + " ===\n";
  txt += "Período fiscal: " + (periodo ? periodo.anio : "sin abrir") + "\n";
  txt += "Inmuebles activos: " + inmuebles.length + "\n";
  txt += "Fondo operativo: Bs " + saldoOpe + "\n";
  txt += "Fondo reserva: Bs " + saldoRes.bs + " + USD " + saldoRes.usd + "\n";
  return txt;
}

function resumenIngresosAsistente_(condominioId) {
  const inmuebles = RepoInmuebles.listarConEdificio(condominioId);
  const inmIds = new Set(inmuebles.map(i => i.id));
  const pagos = sb.select("pagos", "order=created_at.desc&limit=50");
  const filtrados = pagos.filter(p => inmIds.has(p.inmueble_id));

  let total = 0;
  let txt = "=== INGRESOS (últimos pagos) ===\n";
  filtrados.slice(0, 20).forEach(p => {
    total += parseFloat(p.monto_bs);
    txt += "- " + p.fecha_pago + " | " + p.banco + " | Bs " + p.monto_bs + " | " + p.estado + "\n";
  });
  txt += "Total mostrado: Bs " + total.toFixed(2) + "\n";
  return txt;
}

function resumenEgresosAsistente_(condominioId) {
  const egresos = RepoEgresos.listarConCategoria(condominioId, {});
  let total = 0;
  let txt = "=== EGRESOS ===\n";
  egresos.slice(0, 20).forEach(e => {
    total += parseFloat(e.monto_final || e.monto);
    txt += "- " + e.fecha + " | " + (e.categoria ? e.categoria.nombre : "-") + " | Bs " + e.monto + " | " + e.estado + "\n";
  });
  txt += "Total mostrado: Bs " + total.toFixed(2) + "\n";
  return txt;
}

function resumenDeudoresAsistente_(condominioId) {
  try {
    const cuotasMora = ServicioMora.cuotasEnMora(condominioId);
    if (!cuotasMora.length) return "Sin deudores pendientes.";

    const porInmueble = {};
    cuotasMora.forEach(c => {
      if (!porInmueble[c.inmuebleId]) porInmueble[c.inmuebleId] = { meses: 0, deuda: 0 };
      porInmueble[c.inmuebleId].meses++;
      porInmueble[c.inmuebleId].deuda += c.totalConMora;
    });

    let txt = "=== DEUDORES ===\n";
    Object.keys(porInmueble).forEach(inmId => {
      const inm = RepoInmuebles.porId(inmId);
      const d = porInmueble[inmId];
      txt += "- " + (inm ? inm.codigo : inmId) + ": " + d.meses + " meses, Bs " + d.deuda.toFixed(2) + "\n";
    });
    return txt;
  } catch (e) {
    return "Error calculando deudores: " + e.message;
  }
}

function resumenInmueblesAsistente_(condominioId) {
  const inmuebles = RepoInmuebles.listarConEdificio(condominioId);
  let txt = "=== INMUEBLES ===\n";
  inmuebles.slice(0, 30).forEach(i => {
    txt += "- " + (i.edificio ? i.edificio.nombre : "") + " " + i.codigo + " | alícuota " + i.alicuota + "%\n";
  });
  return txt;
}

function resumenFondosAsistente_(condominioId) {
  const ope = RepoFondoOperativo.saldo(condominioId);
  const res = RepoFondoReserva.saldo(condominioId);
  let txt = "=== FONDOS ===\n";
  txt += "Operativo: Bs " + ope + "\n";
  txt += "Reserva Bs: " + res.bs + "\n";
  txt += "Reserva USD: " + res.usd + "\n";
  txt += "Reserva total equiv Bs: " + res.bs_equivalente + "\n";
  return txt;
}

function consultarGroqTexto_(contexto, pregunta) {
  const sistema =
    "Eres el asistente oficial del condominio. Responde breve y formal en español neutro. " +
    "Usa solo los datos entregados. Si no tienes el dato, dilo.\n\n" +
    "Datos disponibles:\n\n" + contexto;

  const payload = {
    model: "openai/gpt-oss-120b",
    messages: [
      { role: "system", content: sistema },
      { role: "user", content: pregunta }
    ],
    temperature: 0.2,
    max_tokens: 500
  };

  const key = PropertiesService.getScriptProperties().getProperty("GROQ_KEY");
  if (!key) return "Error: falta GROQ_KEY.";

  const res = UrlFetchApp.fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + key },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });

  const json = JSON.parse(res.getContentText());
  if (json.error) return "Error Groq: " + json.error.message;
  if (!json.choices || !json.choices[0]) return "Respuesta inválida de Groq.";

  return json.choices[0].message.content;
}

function testPanelAdmin() {
  Logger.log("=== TEST Panel Admin ===");

  const conds = RepoCondominios.listarTodos();
  if (!conds.length) { Logger.log("❌ No hay condominios"); return; }

  const condId = conds[0].id;
  Logger.log("Condominio: " + conds[0].nombre);
  Logger.log("ID: " + condId);

  try {
    const res = apiDashboardAdmin(condId);
    if (!res.exito) {
      Logger.log("❌ Error: " + res.error);
      return;
    }
    Logger.log("✅ Responde OK");
    Logger.log(JSON.stringify(res.data, null, 2));
  } catch (e) {
    Logger.log("❌ EXCEPCIÓN: " + e.message);
    Logger.log("Stack: " + e.stack);
  }
}
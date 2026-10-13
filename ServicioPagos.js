
// ============================================================
// SERVICIO — PAGOS
// Orquesta el ciclo completo: registrar → conciliar →
// aplicar a cuotas → alimentar fondos → saldo a favor.
//
// Reglas aplicadas:
// - RN-220: El fondo se alimenta al conciliar, no al registrar.
// - El split operativo/reserva sale de parametros_fondo_reserva.
// - Aplicar saldo a favor NO genera movimiento de fondo.
// ============================================================

const ServicioPagos = {

  // ----------------------------------------------------------
  // REGISTRAR — el propietario reporta el pago
  // ----------------------------------------------------------
  registrar: function(datos) {
    // Validaciones básicas
    if (!datos.condominioId) throw new Error("Falta condominioId");
    if (!datos.inmuebleId) throw new Error("Falta inmuebleId");
    if (!datos.referencia) throw new Error("Falta referencia");
    if (!datos.monto || datos.monto <= 0) throw new Error("Monto inválido");
    if (!datos.fechaPago) throw new Error("Falta fechaPago");

    // Verificar inmueble
    const inm = RepoInmuebles.porId(datos.inmuebleId);
    if (!inm) throw new Error("Inmueble no encontrado");
    if (!inm.activo) throw new Error("El inmueble está inactivo");

    // Verificar referencia única
    const existente = RepoPagos.porReferencia(datos.condominioId, datos.referencia);
    if (existente) {
      throw new Error("La referencia " + datos.referencia + " ya existe en el condominio.");
    }

    // Calcular monto_bs si el pago es en USD
    let tasa = null;
    let montoBs = datos.monto;
    if (datos.moneda === "USD") {
      const tasaActual = RepoTasasBCV.vigenteEn(datos.fechaPago);
      if (!tasaActual) throw new Error("No hay tasa BCV registrada para " + datos.fechaPago);
      tasa = parseFloat(tasaActual.tasa);
      montoBs = Math.round(datos.monto * tasa * 100) / 100;
    }

    // Crear el pago
    const pago = RepoPagos.crear({
      inmueble_id: datos.inmuebleId,
      persona_id: datos.personaId || null,
      fecha_pago: datos.fechaPago,
      monto: datos.monto,
      moneda: datos.moneda || "BS",
      tasa_bcv: tasa,
      monto_bs: montoBs,
      referencia: datos.referencia,
      banco: datos.banco || null,
      archivo_id: datos.archivoId || null,
      mes_aplicado: datos.mes || null,
      anio_aplicado: datos.anio || null,
      estado: "REGISTRADO"
    });

    return {
      exito: true,
      pago: pago,
      mensaje: "Pago registrado. Pendiente de conciliación bancaria."
    };
  },

  // ----------------------------------------------------------
  // CONCILIAR — el corazón del sistema
  // ----------------------------------------------------------
  conciliar: function(pagoId, opciones) {
    opciones = opciones || {};
    const modo = opciones.modo || "FIFO"; // FIFO | MANUAL
    const aplicacionesManuales = opciones.aplicaciones || null;

    const pago = RepoPagos.porId(pagoId);
    if (!pago) throw new Error("Pago no encontrado: " + pagoId);
    if (pago.estado === "CONCILIADO") throw new Error("Este pago ya está conciliado");
    if (pago.estado === "ANULADO") throw new Error("Este pago está anulado");

    // Datos del inmueble → condominio
    const inm = RepoInmuebles.porId(pago.inmueble_id);
    if (!inm) throw new Error("Inmueble del pago no encontrado");
    const edfRes = sb.select("edificios", "id=eq." + inm.edificio_id);
    if (!edfRes || !edfRes.length) throw new Error("Edificio no encontrado");
    const condominioId = edfRes[0].condominio_id;

    // Periodo fiscal abierto
    const periodo = RepoPeriodosFiscales.abiertoPorCondominio(condominioId);

    // Parámetros del fondo reserva (para el split)
    const params = RepoParametrosFondoReserva.porCondominio(condominioId);
    const pctReserva = params ? parseFloat(params.porcentaje_cuota) / 100 : 0.10;
    const pctOperativo = 1 - pctReserva;

    // 1. Aplicar a cuotas
    const montoBs = parseFloat(pago.monto_bs);
    let aplicadas = [];
    let sobrante = montoBs;

    if (modo === "MANUAL" && aplicacionesManuales && aplicacionesManuales.length) {
      RepoPagos.aplicarManual(pagoId, aplicacionesManuales);
      aplicadas = aplicacionesManuales;
      const totalAplicado = aplicacionesManuales.reduce((s, a) => s + a.monto, 0);
      sobrante = Math.round((montoBs - totalAplicado) * 100) / 100;
    } else {
      const r = RepoPagos.aplicarFIFO(pagoId, pago.inmueble_id, montoBs);
      aplicadas = r.aplicadas;
      sobrante = r.sobrante;
    }

    // 2. Marcar el pago como conciliado
    RepoPagos.marcarConciliado(pagoId);

    // 3. Alimentar fondos (split proporcional)
    const montoOperativo = Math.round(montoBs * pctOperativo * 100) / 100;
    const montoReserva = Math.round(montoBs * pctReserva * 100) / 100;

    RepoFondoOperativo.registrarEntrada({
      condominio_id: condominioId,
      periodo_fiscal_id: periodo ? periodo.id : null,
      fecha: pago.fecha_pago,
      monto: montoOperativo,
      origen_tipo: "PAGO",
      origen_id: pagoId,
      descripcion: "Pago conciliado " + pago.referencia
    });

    RepoFondoReserva.registrarEntrada({
      condominio_id: condominioId,
      periodo_fiscal_id: periodo ? periodo.id : null,
      fecha: pago.fecha_pago,
      moneda: "BS",
      monto: montoReserva,
      origen_tipo: "APORTE_CUOTA",
      origen_id: pagoId,
      descripcion: (pctReserva * 100) + "% del pago " + pago.referencia
    });

    // 4. Saldo a favor si sobró
    let saldoFavor = null;
    if (sobrante > 0.01) {
      saldoFavor = RepoSaldosFavor.crear({
        inmueble_id: pago.inmueble_id,
        monto: sobrante,
        origen_pago_id: pagoId,
        estado: "DISPONIBLE"
      });
    }

    return {
      exito: true,
      pagoId: pagoId,
      cuotasAplicadas: aplicadas.length,
      sobrante: sobrante,
      saldoFavorId: saldoFavor ? saldoFavor.id : null,
      montoOperativo: montoOperativo,
      montoReserva: montoReserva,
      mensaje: "Pago conciliado. " + aplicadas.length + " cuota(s) aplicada(s)."
    };
  },

  // ----------------------------------------------------------
  // ANULAR — reversión completa si estaba conciliado
  // ----------------------------------------------------------
  anular: function(pagoId, motivo) {
    const pago = RepoPagos.porId(pagoId);
    if (!pago) throw new Error("Pago no encontrado");
    if (pago.estado === "ANULADO") throw new Error("El pago ya estaba anulado");

    // Si estaba conciliado, revertir todo
    if (pago.estado === "CONCILIADO" || pago.estado === "APLICADO") {
      // Revertir aplicaciones de cuotas
      const aps = RepoPagos.listarAplicaciones(pagoId);
      aps.forEach(ap => {
        RepoCuotas.aplicarPago(ap.cuota_id, -parseFloat(ap.monto_aplicado));
      });

      // Revertir fondos
      const montoBs = parseFloat(pago.monto_bs);
      const inm = RepoInmuebles.porId(pago.inmueble_id);
      const edfRes = sb.select("edificios", "id=eq." + inm.edificio_id);
      const condominioId = edfRes[0].condominio_id;
      const periodo = RepoPeriodosFiscales.abiertoPorCondominio(condominioId);
      const params = RepoParametrosFondoReserva.porCondominio(condominioId);
      const pctReserva = params ? parseFloat(params.porcentaje_cuota) / 100 : 0.10;

      RepoFondoOperativo.registrarSalida({
        condominio_id: condominioId,
        periodo_fiscal_id: periodo ? periodo.id : null,
        fecha: new Date().toISOString().substring(0, 10),
        monto: Math.round(montoBs * (1 - pctReserva) * 100) / 100,
        origen_tipo: "AJUSTE",
        descripcion: "Reversión por anulación: " + pago.referencia
      });

      RepoFondoReserva.registrarSalida({
        condominio_id: condominioId,
        periodo_fiscal_id: periodo ? periodo.id : null,
        fecha: new Date().toISOString().substring(0, 10),
        moneda: "BS",
        monto: Math.round(montoBs * pctReserva * 100) / 100,
        origen_tipo: "AJUSTE",
        descripcion: "Reversión por anulación: " + pago.referencia
      });

      // Anular saldos a favor huérfanos de este pago
      const sfs = sb.select("saldos_favor",
        "origen_pago_id=eq." + pagoId + "&estado=eq.DISPONIBLE");
      sfs.forEach(sf => RepoSaldosFavor.anular(sf.id));
    }

    RepoPagos.anular(pagoId);
    return { exito: true, mensaje: "Pago anulado correctamente." };
  },

  // ----------------------------------------------------------
  // APLICAR SALDO A FAVOR — a una cuota específica
  // NO genera movimiento de fondo (el dinero ya ingresó)
  // ----------------------------------------------------------
  aplicarSaldoAFavor: function(saldoFavorId, cuotaId) {
    const saldo = RepoSaldosFavor.porId(saldoFavorId);
    if (!saldo) throw new Error("Saldo a favor no encontrado");
    if (saldo.estado !== "DISPONIBLE") throw new Error("El saldo no está disponible");

    const cuota = RepoCuotas.porId(cuotaId);
    if (!cuota) throw new Error("Cuota no encontrada");
    if (saldo.inmueble_id !== cuota.inmueble_id) {
      throw new Error("El saldo y la cuota deben ser del mismo inmueble");
    }

    const montoSaldo = parseFloat(saldo.monto);
    const saldoCuota = parseFloat(cuota.saldo);
    if (saldoCuota <= 0) throw new Error("La cuota ya está pagada");

    const aAplicar = Math.round(Math.min(montoSaldo, saldoCuota) * 100) / 100;

    RepoCuotas.aplicarPago(cuotaId, aAplicar);

    const restante = Math.round((montoSaldo - aAplicar) * 100) / 100;
    if (restante <= 0.01) {
      RepoSaldosFavor.aplicar(saldoFavorId);
    } else {
      RepoSaldosFavor.actualizar(saldoFavorId, { monto: restante });
    }

    return { exito: true, aplicado: aAplicar, restante: restante };
  },

  // ----------------------------------------------------------
  // DASHBOARD — saldo a favor total de un inmueble
  // ----------------------------------------------------------
  saldoAFavorDisponible: function(inmuebleId) {
    return RepoSaldosFavor.totalDisponible(inmuebleId);
  }

};

// ============================================================
// TEST — ServicioPagos
// ============================================================
function testServicioPagos() {
  Logger.log("=== TEST ServicioPagos ===");

  const nombreTest = "Test Servicio Pagos";
  const previo = RepoCondominios.porNombre(nombreTest);
  if (previo) RepoCondominios.eliminar(previo.id);

  // ----------------------------------------------------------
  // SETUP
  // ----------------------------------------------------------
  Logger.log("\n--- Setup ---");
  const cond = RepoCondominios.crear({ nombre: nombreTest, email: "test@serv.com" });
  const edf = RepoEdificios.crear({ condominio_id: cond.id, nombre: "Edf Test", orden: 1 });
  const inm = RepoInmuebles.crear({ edificio_id: edf.id, codigo: "1-A", alicuota: 5.0 });
  const per = RepoPeriodosFiscales.crear({
    condominio_id: cond.id, anio: 2026,
    desde: "2026-01-01", hasta: "2026-12-31", estado: "ABIERTO"
  });
  RepoParametrosFondoReserva.crearConDefaults(cond.id);
  RepoTasasBCV.guardar("2026-10-01", 40.00, "TEST");
  Logger.log("Setup OK");

  // ----------------------------------------------------------
  // Crear 5 cuotas de Bs 700 c/u
  // ----------------------------------------------------------
  const c1 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Oct", monto_original: 700,
    fecha_emision: "2026-10-01", fecha_vencimiento: "2026-10-15"
  });
  const c2 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Nov", monto_original: 700,
    fecha_emision: "2026-11-01", fecha_vencimiento: "2026-11-15"
  });
    const c3 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Dic", monto_original: 700,
    fecha_emision: "2026-12-01", fecha_vencimiento: "2026-12-15"
  });
  const c4 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Ene 2027", monto_original: 700,
    fecha_emision: "2027-01-01", fecha_vencimiento: "2027-01-15"
  });
  Logger.log("4 cuotas de Bs 700 creadas");

  const c5 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Feb 2027", monto_original: 700,
    fecha_emision: "2027-02-01", fecha_vencimiento: "2027-02-15"
  });
  Logger.log("5 cuotas de Bs 700 creadas");

  // ----------------------------------------------------------
  // 1. REGISTRAR PAGO (sin conciliar)
  // ----------------------------------------------------------
  Logger.log("\n--- 1. Registrar pago (sin conciliar) ---");
  const r1 = ServicioPagos.registrar({
    condominioId: cond.id,
    inmuebleId: inm.id,
    fechaPago: "2026-10-05",
    monto: 3200,
    moneda: "BS",
    referencia: "REF-SERV-001",
    banco: "Banesco"
  });
  Logger.log("Pago registrado: " + r1.pago.id);
  Logger.log("Estado: " + r1.pago.estado);

  // Verificar que NO se aplicó a cuotas
  const c1Antes = RepoCuotas.porId(c1.id);
  Logger.log("Cuota1 antes de conciliar: " + c1Antes.estado + " (saldo " + c1Antes.saldo + ")");

  // Verificar que fondos están en 0
  Logger.log("Fondo operativo: Bs " + RepoFondoOperativo.saldo(cond.id));
  Logger.log("Fondo reserva:   " + JSON.stringify(RepoFondoReserva.saldo(cond.id)));

  // ----------------------------------------------------------
  // 2. CONCILIAR (FIFO)
  // ----------------------------------------------------------
  Logger.log("\n--- 2. Conciliar (FIFO) ---");
  const r2 = ServicioPagos.conciliar(r1.pago.id, { modo: "FIFO" });
  Logger.log("Cuotas aplicadas: " + r2.cuotasAplicadas);
  Logger.log("Sobrante: Bs " + r2.sobrante);
  Logger.log("Fondo operativo +: Bs " + r2.montoOperativo);
  Logger.log("Fondo reserva +:   Bs " + r2.montoReserva);

  // ----------------------------------------------------------
  // 3. VERIFICAR ESTADOS
  // ----------------------------------------------------------
  Logger.log("Cuota1: " + RepoCuotas.porId(c1.id).estado);
  Logger.log("Cuota2: " + RepoCuotas.porId(c2.id).estado);
  Logger.log("Cuota3: " + RepoCuotas.porId(c3.id).estado);
  Logger.log("Cuota4: " + RepoCuotas.porId(c4.id).estado);
  Logger.log("Cuota5: " + RepoCuotas.porId(c5.id).estado + " (saldo " + RepoCuotas.porId(c5.id).saldo + ")");

  Logger.log("Fondo operativo: Bs " + RepoFondoOperativo.saldo(cond.id));
  Logger.log("Fondo reserva:   " + JSON.stringify(RepoFondoReserva.saldo(cond.id)));

  const saldoFavor = ServicioPagos.saldoAFavorDisponible(inm.id);
  Logger.log("Saldo a favor: Bs " + saldoFavor);

  // ----------------------------------------------------------
  // 4. APLICAR SALDO A FAVOR
  // ----------------------------------------------------------
  Logger.log("\n--- 4. Aplicar saldo a favor a Cuota5 ---");
  const sfs = RepoSaldosFavor.disponiblesPorInmueble(inm.id);
  if (sfs.length) {
    const r4 = ServicioPagos.aplicarSaldoAFavor(sfs[0].id, c5.id);
    Logger.log("Aplicado: Bs " + r4.aplicado);
    Logger.log("Restante del saldo: Bs " + r4.restante);
    Logger.log("Cuota5 después: " + RepoCuotas.porId(c5.id).estado + " (saldo " + RepoCuotas.porId(c5.id).saldo + ")");
    Logger.log("Fondo operativo sigue: Bs " + RepoFondoOperativo.saldo(cond.id) + " (no debe cambiar)");
  }

  // ----------------------------------------------------------
  // 5. ANULAR PAGO
  // ----------------------------------------------------------
  Logger.log("\n--- 5. Anular pago ---");
  const r5 = ServicioPagos.anular(r1.pago.id, "Prueba de reversión");
  Logger.log("Mensaje: " + r5.mensaje);
  Logger.log("Fondo operativo después: Bs " + RepoFondoOperativo.saldo(cond.id));
  Logger.log("Fondo reserva después:   " + JSON.stringify(RepoFondoReserva.saldo(cond.id)));
  Logger.log("Cuota1 después: " + RepoCuotas.porId(c1.id).estado + " (saldo " + RepoCuotas.porId(c1.id).saldo + ")");

  // Limpieza
  RepoCondominios.eliminar(cond.id);
  Logger.log("\n=== TEST FINALIZADO ===");
}
# Rifa CCS

Mini app real para la rifa del Ciclo Club Santiago con:

- panel público para ver y reservar números 001–300
- bloqueo temporal real de 30 minutos persistido en base de datos
- reserva múltiple atómica
- liberación automática por vencimiento
- panel administrativo privado para Solange
- confirmación de pago, liberación manual, conflicto e historial

## Stack elegido

- Frontend: HTML/CSS/JS moderno, mobile first
- Backend: Node.js nativo sin dependencias externas
- Base de datos: Supabase Postgres
- Concurrencia: funciones SQL transaccionales con bloqueo `FOR UPDATE`

La decisión de usar Node nativo sin framework deja el despliegue muy simple y evita depender de `npm install` para poder ejecutar el backend. Toda la lógica crítica vive en Postgres.

## Estructura del proyecto

```text
.
├── .env.example
├── README.md
├── package.json
├── public
│   ├── admin.css
│   ├── admin.html
│   ├── admin-login.html
│   ├── admin.js
│   ├── app.css
│   ├── app.js
│   └── assets
│       └── logo_ccs.png
├── server.js
└── supabase
    └── schema.sql
```

## Modelo de datos

### `reservations`

- una reserva agrupa uno o varios números
- guarda comprador, expiración del hold y estado global

Estados:

- `held`
- `reserved_pending_payment`
- `paid_confirmed`
- `released`
- `expired`
- `conflict`

### `tickets`

- 300 filas, una por número
- representa el estado actual operativo del ticket

Estados:

- `available`
- `held`
- `reserved_pending_payment`
- `paid_confirmed`
- `conflict`

### `reservation_tickets`

- tabla puente que preserva qué números pertenecieron a cada reserva
- permite historial incluso después de liberar tickets

### `ticket_events`

- historial auditable por ticket y reserva

## Lógica de concurrencia

La función `create_reservation_hold(...)` hace lo importante:

1. libera reservas expiradas
2. normaliza y valida el arreglo de números
3. bloquea las filas objetivo con `FOR UPDATE`
4. verifica si alguno ya no está `available`
5. si todos están libres, crea una reserva única
6. actualiza todos los tickets juntos dentro de la misma transacción
7. registra eventos

Resultado:

- dos usuarios no pueden quedarse con el mismo número al mismo tiempo
- varios números se reservan juntos de forma consistente
- si uno falla, se informa conflicto y no se confirma el lote

## Configuración de entorno

1. Copia `.env.example` a `.env`
2. Completa:

```env
PORT=3000
HOST=127.0.0.1
APP_URL=http://localhost:3000
HOLD_MINUTES=30

SUPABASE_URL=https://TU-PROYECTO.supabase.co
SUPABASE_SERVICE_ROLE_KEY=TU_SERVICE_ROLE_KEY

ADMIN_PASSWORD=una-clave-fuerte-para-solange
ADMIN_NAME=Solange
ADMIN_SESSION_SECRET=un-secreto-largo-y-aleatorio
```

## Configurar Supabase

1. Crea un proyecto en Supabase
2. Abre SQL Editor
3. Ejecuta completo [supabase/schema.sql](/Users/cesarmora/Documents/Rifa%20CCS/supabase/schema.sql)
4. Verifica que se hayan creado:

- tablas `reservations`, `tickets`, `reservation_tickets`, `ticket_events`
- vistas `ticket_public_view`, `ticket_admin_view`, `reservation_admin_view`, `ticket_events_view`
- funciones `create_reservation_hold`, `get_public_reservation`, `admin_update_reservation_status`, `release_expired_reservations`

Notas:

- el script siembra automáticamente los tickets 1–300
- si `pg_cron` está disponible, programa la liberación cada minuto
- aunque no esté `pg_cron`, el backend también llama `release_expired_reservations()` antes de leer o mutar datos

## Ejecutar localmente

Con Node 18+ basta:

```bash
node server.js
```

Luego abre:

- público: [http://localhost:3000](http://localhost:3000)
- admin: [http://localhost:3000/admin/login](http://localhost:3000/admin/login)

## Flujo funcional

### Público

1. selecciona uno o varios números disponibles
2. completa nombre y teléfono
3. confirma la reserva
4. el backend crea un `hold` real por 30 minutos
5. se muestran datos de transferencia y contador
6. si no se valida el pago dentro del plazo, vuelven a `available`

### Admin Solange

1. entra por `/admin/login`
2. busca por comprador, teléfono o número
3. revisa reservas activas
4. puede:

- marcar pendiente de pago
- confirmar pago
- liberar números manualmente
- marcar conflicto

5. ve historial de eventos reciente

## Despliegue simple

### Opción recomendada

Despliega en un servicio Node sencillo como Railway, Render, Fly.io o un VPS pequeño.

Pasos generales:

1. sube esta carpeta a un repositorio
2. crea servicio Node
3. define las variables `.env`
4. comando de inicio:

```bash
node server.js
```

### Opción VPS básica

```bash
node server.js
```

Y luego publicar detrás de Nginx o Caddy.

## Consideraciones de seguridad

- la `SUPABASE_SERVICE_ROLE_KEY` queda solo en el servidor
- el navegador nunca habla directo con Supabase
- el panel admin usa cookie firmada en backend
- las tablas tienen RLS activado y no dependen de acceso directo desde cliente

## Qué incluye este MVP

- selección múltiple
- bloqueo temporal real
- persistencia real en Supabase
- expiración automática
- panel público funcional
- panel admin funcional
- confirmación mínima de pago
- liberación manual
- conflicto
- historial operativo

## Siguientes mejoras recomendables

- subir comprobante de transferencia
- exportación CSV
- auditoría por vendedor
- notificaciones WhatsApp o correo
- contador por reserva también en admin

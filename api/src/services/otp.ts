/**
 * Envio de OTP por SMS. El codigo NUNCA se guarda en texto plano: se hashea con
 * bcrypt antes de insertarse en `otp_codes` y el log del provider no lo incluye.
 *
 * Para desarrollo/pruebas se usa PORTAL_OTP_PROVIDER=console (el codigo se
 * imprime en el log del servidor). Para produccion, PORTAL_OTP_PROVIDER=twilio
 * requiere TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN y TWILIO_FROM.
 */
export async function sendSms(phone: string, code: string): Promise<void> {
    const {
        TWILIO_ACCOUNT_SID,
        TWILIO_AUTH_TOKEN,
        TWILIO_FROM,
    } = process.env;

    if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM) {
        throw new Error(
            'PORTAL_OTP_PROVIDER=twilio requiere TWILIO_ACCOUNT_SID, '
            + 'TWILIO_AUTH_TOKEN y TWILIO_FROM en el entorno.'
        );
    }

    const body = new URLSearchParams({
        To: `+52${phone}`,
        From: TWILIO_FROM,
        Body: `Tu codigo de acceso es ${code}. Expira en 5 minutos.`,
    });

    const response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json`,
        {
            method: 'POST',
            headers: {
                Authorization: `Basic ${Buffer.from(`${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}`).toString('base64')}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body,
        }
    );

    if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`Twilio respondio ${response.status}: ${detail.slice(0, 200)}`);
    }
}

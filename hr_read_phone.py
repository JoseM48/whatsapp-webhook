# E:\DESARROLLOS\whatsapp-webhook\hr_read_phone.py

from appium import webdriver
from appium.options.common import AppiumOptions
from appium.webdriver.common.appiumby import AppiumBy
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC
import re

# =========================
# Configuración del dispositivo/app
# =========================
APP_PACKAGE  = "com.io.hotelrunner"
APP_ACTIVITY = "com.io.hotelrunner.MainActivity"
DEVICE_NAME  = "emulator-5554"

# Si tienes el resource-id exacto del campo teléfono, colócalo aquí (recomendado)
PHONE_FIELD_ID = None  # p.ej.: "com.io.hotelrunner:id/et_phone_number"

# =========================
# Normalización para WhatsApp Cloud (E.164 sin '+')
# =========================
def to_whatsapp_number(raw: str, default_region_cc: str | None = None) -> str | None:
    """
    Devuelve el número listo para WhatsApp Cloud API: solo dígitos con código país.
    Reglas:
      - Acepta entradas con +, con 00, con espacios/guiones: se limpian.
      - Si quedan 11–15 dígitos: asumimos que ya incluyen código de país → OK.
      - Si quedan exactamente 10 dígitos y se indica default_region_cc (ej '57'): lo antepone.
      - Cualquier otro caso: None.
    """
    if not raw:
        return None

    # Quitar todo lo no numérico, pero antes manejar prefijos comunes
    s = raw.strip()
    if s.startswith("+"):  # +57..., +1...
        s = s[1:]
    elif s.startswith("00"):  # 0057..., 001...
        s = s[2:]

    digits = re.sub(r"\D+", "", s)

    # Longitudes válidas para E.164 (máx. 15 dígitos)
    if 11 <= len(digits) <= 15:
        return digits

    if len(digits) == 10 and default_region_cc:
        return default_region_cc + digits

    return None

# =========================
# Appium: crear sesión (prueba / y /wd/hub)
# =========================
def make_driver(caps: dict) -> webdriver.Remote:
    options = AppiumOptions()
    options.load_capabilities(caps)
    last_err = None
    for url in ("http://127.0.0.1:4723", "http://127.0.0.1:4723/wd/hub"):
        try:
            d = webdriver.Remote(url, options=options)
            print(f"[OK] Conectado a Appium en: {url}")
            return d
        except Exception as e:
            last_err = e
    raise last_err

# =========================
# Extracción del teléfono en pantalla
# =========================
def get_phone(driver, wait: WebDriverWait) -> str | None:
    # 1) Por resource-id (si lo tienes)
    if PHONE_FIELD_ID:
        try:
            el = wait.until(EC.presence_of_element_located((AppiumBy.ID, PHONE_FIELD_ID)))
            t = (el.get_attribute("text") or "").strip()
            if t:
                return t
        except Exception:
            pass

    # 2) XPath: hermano siguiente después de la etiqueta "Phone number"
    try:
        el = driver.find_element(
            AppiumBy.XPATH,
            "//android.widget.TextView[@text='Phone number']/following-sibling::android.widget.EditText[1]"
        )
        t = (el.get_attribute("text") or "").strip()
        if t:
            return t
    except Exception:
        pass

    # 3) XPath: buscar EditText dentro del contenedor que incluye la etiqueta
    try:
        el = driver.find_element(
            AppiumBy.XPATH,
            "//android.view.ViewGroup[.//android.widget.TextView[@text='Phone number']]//android.widget.EditText"
        )
        t = (el.get_attribute("text") or "").strip()
        if t:
            return t
    except Exception:
        pass

    # 4) Fallback: el EditText con más dígitos visibles (>=7)
    try:
        candidates = []
        for e in driver.find_elements(AppiumBy.CLASS_NAME, "android.widget.EditText"):
            t = (e.get_attribute("text") or "").strip()
            if re.search(r"\d{7,}", t):
                candidates.append(t)
        if candidates:
            # Si hay varios, toma el de más dígitos
            return max(candidates, key=lambda x: len(re.sub(r"\D+", "", x)))
    except Exception:
        pass

    return None

# =========================
# Main
# =========================
if __name__ == "__main__":
    caps = {
        "platformName": "Android",
        "automationName": "UiAutomator2",
        "deviceName": DEVICE_NAME,
        "appPackage": APP_PACKAGE,
        "appActivity": APP_ACTIVITY,
        "noReset": True,
        "newCommandTimeout": 300
    }

    driver = make_driver(caps)
    wait = WebDriverWait(driver, 15)

    phone_raw = get_phone(driver, wait)
    print("PHONE_RAW  =>", phone_raw or "NO ENCONTRADO")

    # Sin país por defecto: exige 11–15 dígitos (internacional)
    phone_e164 = to_whatsapp_number(phone_raw)
    # Si quisieras asumir un país por defecto para números de 10 dígitos, descomenta:
    # phone_e164 = to_whatsapp_number(phone_raw, default_region_cc="57")  # Colombia, por ejemplo

    print("PHONE_E164 =>", phone_e164 or "NO VÁLIDO")

    driver.quit()

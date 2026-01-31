import asyncio
import json
from datetime import datetime, timezone
from agents import Agent, Runner

STABLECOIN = "USDC"  # Change to "BRZ" if you want later

def must_be_json(label: str, s: str) -> dict:
    """Fail fast if an agent output isn't valid JSON."""
    try:
        return json.loads(s)
    except json.JSONDecodeError as e:
        raise SystemExit(f"{label} did not output valid JSON: {e}\nOutput was:\n{s}")

def now_iso_utc() -> str:
    return datetime.now(timezone.utc).isoformat()

async def main():
    # Agent 1: Car Sensors
    sensors_agent = Agent(
        name="Car Sensors Agent",
        instructions=(
            "You simulate car sensors. Output VALID JSON only. No markdown.\n\n"
            "Output exactly the event:\n\n"
            "Fuel is low:\n"
            "{\n"
            '  "event": "FUEL_LOW_DETECTED",\n'
            '  "car_id": "car-001",\n'
            '  "timestamp": "ISO-8601 string",\n'
            '  "location": {"lat": number, "lon": number},\n'
            '  "odometer_km": number,\n'
            '  "fuel_level_percent": number,\n'
            '  "range_km_estimate": number,\n'
            '  "severity": "LOW" | "MEDIUM" | "HIGH"\n'
            "}\n\n"            
            "Rules:\n"
            "- Use realistic values.\n"
            "- Severity thresholds: LOW if > 25; MEDIUM if 10-25; HIGH if < 10.\n"
            "- location should look like a real coordinate (e.g., Sao Paulo area).\n"
            "- timestamp must be ISO-8601.\n"
            "- Keep it simple."
        ),
    )

    # Agent 2: Car Trader (policy-based)
    trader_agent = Agent(
        name="Car Trader Agent",
        instructions=(
            "You are a car trading agent. You receive a sensor JSON event.\n"
            "Output VALID JSON only. No markdown.\n\n"
            "If event is FUEL_OK: output:\n"
            '{ "event": "NO_ACTION", "car_id": "car-001", "reason": "Fuel level OK" }\n\n'
            "If event is FUEL_LOW_DETECTED: create a fuel purchase request as VALID JSON only.\n\n"
            "Fuel request schema:\n"
            "{\n"
            '  "event": "FUEL_REQUEST",\n'
            '  "car_id": "string",\n'
            '  "timestamp": "ISO-8601 string",\n'
            '  "location": {"lat": number, "lon": number},\n'
            '  "fuel_type": "GASOLINE" | "ETHANOL" | "DIESEL",\n'
            '  "liters": number,\n'
            '  "max_price_per_liter_usd": number,\n'
            f'  "payment_token": "{STABLECOIN}",\n'
            '  "delivery_deadline_minutes": number,\n'
            '  "policy": {\n'
            '    "severity": "LOW" | "MEDIUM" | "HIGH",\n'
            '    "priority": "CHEAPEST" | "BALANCED" | "FASTEST"\n'
            "  },\n"
            '  "reason": "string"\n'
            "}\n\n"
            "Policy rules (MUST follow):\n"
            "- Stablecoin only (payment_token fixed).\n"
            "- If severity HIGH:\n"
            "  liters: 35-45, max_price_per_liter_usd: 2.2-2.8, deadline: 10-15, priority: FASTEST.\n"
            "- If severity MEDIUM:\n"
            "  liters: 20-30, max_price_per_liter_usd: 1.8-2.4, deadline: 15-25, priority: BALANCED.\n"
            "- If severity LOW:\n"
            "  liters: 10-20, max_price_per_liter_usd: 1.4-2.0, deadline: 25-40, priority: CHEAPEST.\n"
            "- Use the incoming timestamp/location from sensors in the request.\n"
            "- reason must mention the severity and the chosen priority."
        ),
    )

    # Agent 3: Gas Station (stablecoin-only + payment instructions)
    station_agent = Agent(
        name="Gas Station Agent",
        instructions=(
            "You are a gas station agent. You receive a FUEL_REQUEST JSON.\n"
            "Reply with a quote as VALID JSON only. No markdown.\n\n"
            "Quote schema:\n"
            "{\n"
            '  "event": "FUEL_QUOTE",\n'
            '  "station_id": "station-777",\n'
            '  "timestamp": "ISO-8601 string",\n'
            '  "car_id": "string",\n'
            '  "fuel_type": "string",\n'
            '  "liters": number,\n'
            '  "price_per_liter_usd": number,\n'
            '  "total_usd": number,\n'
            f'  "payment_token": "{STABLECOIN}",\n'
            '  "payment_address": "string",\n'
            '  "payment_memo": "string",\n'
            '  "expires_in_seconds": number,\n'
            '  "next_step": "string"\n'
            "}\n\n"
            "Rules:\n"
            "- Accept ONLY the stablecoin payment_token provided.\n"
            "- Try to keep price_per_liter_usd <= max_price_per_liter_usd.\n"
            "- total_usd must equal liters * price_per_liter_usd.\n"
            "- payment_address must look like a blockchain address (mock is fine).\n"
            "- payment_memo must be a short unique identifier like 'car-001:INV-1234'.\n"
            "- next_step must clearly instruct: send exact stablecoin amount to address with memo.\n"
            "- timestamp must be ISO-8601."
        ),
    )

    # ----------------------
    # Step 1: Sensors checks
    # ----------------------
    sensors_input = f"check sensors now; timestamp={now_iso_utc()}"
    sensors_out = await Runner.run(sensors_agent, sensors_input)
    sensors_json = sensors_out.final_output
    print("\n--- Sensors -> Trader (event) ---")
    print(sensors_json)

    sensors_event = must_be_json("Sensors Agent", sensors_json)

    # ----------------------
    # Step 2: Trader decides
    # ----------------------
    trader_in = json.dumps(sensors_event, ensure_ascii=False)
    trader_out = await Runner.run(trader_agent, trader_in)
    trader_json = trader_out.final_output
    print("\n--- Trader -> Station (request or no action) ---")
    print(trader_json)

    trader_event = must_be_json("Trader Agent", trader_json)

    if trader_event.get("event") == "NO_ACTION":
        print("\n✅ No action needed (fuel OK).")
        return

    # ----------------------
    # Step 3: Station quotes
    # ----------------------
    station_in = json.dumps(trader_event, ensure_ascii=False)
    station_out = await Runner.run(station_agent, station_in)
    station_json = station_out.final_output
    print("\n--- Station -> Trader/Car (quote) ---")
    print(station_json)

    quote = must_be_json("Station Agent", station_json)

    # ----------------------
    # Sanity checks
    # ----------------------
    liters = float(quote["liters"])
    ppl = float(quote["price_per_liter_usd"])
    total = float(quote["total_usd"])
    expected = liters * ppl
    if abs(total - expected) > 1e-6:
        raise SystemExit(f"Math check failed: total_usd={total} expected={expected}")

    if quote.get("payment_token") != STABLECOIN:
        raise SystemExit(f"Payment token mismatch: expected {STABLECOIN}, got {quote.get('payment_token')}")

    if not quote.get("payment_address") or not quote.get("payment_memo"):
        raise SystemExit("Missing payment_address or payment_memo in quote")

    print("\n✅ Flow complete (stablecoin-only, JSON valid, math ok, payment instructions included).")

if __name__ == "__main__":
    asyncio.run(main())
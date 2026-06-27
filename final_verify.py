from playwright.sync_api import sync_playwright
import time

def run_verification():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        page.set_viewport_size({"width": 1280, "height": 800})

        try:
            page.goto("http://localhost:8000")
            page.wait_for_selector(".grid-cell", timeout=10000)
            time.sleep(2)
            # Add Itten Circle as a representative effect
            page.click("text=Круг Иттена")
            time.sleep(3)
            page.screenshot(path="final_result.png")
            print("Final verification screenshot saved.")
        except Exception as e:
            print(f"Error: {e}")
        finally:
            browser.close()

if __name__ == "__main__":
    run_verification()

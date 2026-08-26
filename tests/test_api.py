"""
Legal Scout — API Test Suite
Run: python tests/test_api.py
"""

import os
import sys
import time

import requests

API = os.getenv("API_HOST", "http://localhost:8001")
TOKEN = None


def test(name, passed, detail=""):
    status = "✅" if passed else "❌"
    print(f"  {status} {name}" + (f" — {detail}" if detail else ""))
    return passed


def run_tests():
    global TOKEN
    passed = 0
    failed = 0
    total = 0

    print("\n" + "=" * 60)
    print("LEGAL SCOUT — API TEST SUITE")
    print("=" * 60)

    # === AUTH TESTS ===
    print("\n--- Authentication ---")

    # Test 1: Login without credentials
    total += 1
    r = requests.post(f"{API}/api/auth/login", json={})
    if test("Login without credentials returns error", r.json().get("error")):
        passed += 1
    else:
        failed += 1

    # Test 2: Login with wrong password
    total += 1
    r = requests.post(f"{API}/api/auth/login", json={"email": "admin@legalscout.com", "password": "wrong"})
    if test("Login with wrong password fails", not r.json().get("success")):
        passed += 1
    else:
        failed += 1

    # Test 3: Login with correct credentials
    total += 1
    r = requests.post(f"{API}/api/auth/login", json={"email": "admin@legalscout.com", "password": "admin123"})
    data = r.json()
    TOKEN = data.get("token")
    if test(
        "Login with correct credentials", data.get("success") and TOKEN, f"role={data.get('user', {}).get('role')}"
    ):
        passed += 1
    else:
        failed += 1

    # Test 4: Unauthenticated access blocked
    total += 1
    r = requests.get(f"{API}/api/dashboard/data")
    if test("Unauthenticated access returns 401", r.status_code == 401):
        passed += 1
    else:
        failed += 1

    # Test 5: Authenticated access works
    total += 1
    headers = {"Authorization": f"Bearer {TOKEN}"}
    r = requests.get(f"{API}/api/dashboard/data", headers=headers)
    if test("Authenticated access returns 200", r.status_code == 200):
        passed += 1
    else:
        failed += 1

    # Test 6: Invalid token rejected
    total += 1
    r = requests.get(f"{API}/api/dashboard/data", headers={"Authorization": "Bearer invalid_token"})
    if test("Invalid token returns 401", r.status_code == 401):
        passed += 1
    else:
        failed += 1

    # === VALIDATION TESTS ===
    print("\n--- Input Validation ---")

    # Test 7: Invalid email format
    total += 1
    r = requests.post(f"{API}/api/auth/login", json={"email": "not-an-email", "password": "test"})
    if test("Invalid email format rejected", "Invalid email" in r.json().get("error", "")):
        passed += 1
    else:
        failed += 1

    # Test 8: Create user with bad role
    total += 1
    r = requests.post(
        f"{API}/api/admin/users",
        headers=headers,
        json={"email": "test@test.com", "password": "test123", "role": "superadmin"},
    )
    if test("Invalid role rejected", "Role must be" in r.json().get("error", "")):
        passed += 1
    else:
        failed += 1

    # Test 9: Short password rejected
    total += 1
    r = requests.post(
        f"{API}/api/admin/users", headers=headers, json={"email": "test@test.com", "password": "ab", "role": "user"}
    )
    if test("Short password rejected", "at least 6" in r.json().get("error", "")):
        passed += 1
    else:
        failed += 1

    # === RATE LIMITING ===
    print("\n--- Rate Limiting ---")

    # Test 10: Rate limiting works (6 rapid login attempts)
    total += 1
    blocked = False
    for _i in range(7):
        r = requests.post(f"{API}/api/auth/login", json={"email": "x@x.com", "password": "wrong"})
        if r.status_code == 429:
            blocked = True
            break
    if test("Login rate limiting triggers after 5 attempts", blocked):
        passed += 1
    else:
        failed += 1
    time.sleep(2)  # Wait for rate limit window

    # === DASHBOARD ===
    print("\n--- Dashboard ---")

    total += 1
    r = requests.get(f"{API}/api/dashboard/stats", headers=headers)
    if test("Dashboard stats endpoint", r.status_code == 200):
        passed += 1
    else:
        failed += 1

    total += 1
    r = requests.get(f"{API}/api/dashboard/templates", headers=headers)
    if test("Templates endpoint", r.status_code == 200 and "templates" in r.json()):
        passed += 1
    else:
        failed += 1

    total += 1
    r = requests.get(f"{API}/api/dashboard/documents", headers=headers)
    if test("Documents endpoint", r.status_code == 200):
        passed += 1
    else:
        failed += 1

    # === TRAINING ===
    print("\n--- Training ---")

    total += 1
    r = requests.get(f"{API}/api/training/status", headers=headers)
    if test("Training status endpoint", r.status_code == 200):
        passed += 1
    else:
        failed += 1

    # === KNOWLEDGE ===
    print("\n--- Knowledge ---")

    total += 1
    r = requests.get(f"{API}/api/knowledge/sources", headers=headers)
    if test("Knowledge sources endpoint", r.status_code == 200):
        passed += 1
    else:
        failed += 1

    # === USERS (ADMIN) ===
    print("\n--- User Management ---")

    total += 1
    r = requests.get(f"{API}/api/admin/users", headers=headers)
    if test("List users (admin)", r.status_code == 200 and len(r.json().get("users", [])) >= 1):
        passed += 1
    else:
        failed += 1

    total += 1
    r = requests.post(
        f"{API}/api/admin/users",
        headers=headers,
        json={"email": "testuser@test.com", "password": "test123456", "name": "Test User", "role": "user"},
    )
    if test("Create user", r.json().get("success")):
        passed += 1
    else:
        failed += 1

    total += 1
    r = requests.get(f"{API}/api/admin/activity-logs", headers=headers)
    if test("Activity logs", r.status_code == 200):
        passed += 1
    else:
        failed += 1

    # === AGENT ===
    print("\n--- Agent ---")

    total += 1
    r = requests.get(f"{API}/agents")
    if test("Agent listing", r.status_code == 200):
        passed += 1
    else:
        failed += 1

    # === SUMMARY ===
    print("\n" + "=" * 60)
    print(f"RESULTS: {passed}/{total} passed, {failed} failed")
    print("=" * 60)

    return failed == 0


if __name__ == "__main__":
    success = run_tests()
    sys.exit(0 if success else 1)

import os
from datetime import datetime
from pathlib import Path

from flask import Flask, jsonify, redirect, render_template, request, url_for, flash
from flask_login import LoginManager, UserMixin, current_user, login_required, login_user, logout_user
from flask_sqlalchemy import SQLAlchemy
from flask_wtf import CSRFProtect
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
INSTANCE_DIR = BASE_DIR / "instance"
INSTANCE_DIR.mkdir(exist_ok=True)

app = Flask(__name__, instance_path=str(INSTANCE_DIR))
secret_key = os.environ.get("SECRET_KEY")
if not secret_key:
    if os.environ.get("RENDER"):
        raise RuntimeError("SECRET_KEY must be set in production.")
    secret_key = "change-this-development-secret-key"

database_url = os.environ.get("DATABASE_URL", f"sqlite:///{INSTANCE_DIR / 'cmh_scheduler.db'}")
if database_url.startswith("postgres://"):
    database_url = "postgresql+psycopg://" + database_url[len("postgres://"):]
elif database_url.startswith("postgresql://"):
    database_url = "postgresql+psycopg://" + database_url[len("postgresql://"):]

app.config.update(
    SECRET_KEY=secret_key,
    SQLALCHEMY_DATABASE_URI=database_url,
    SQLALCHEMY_TRACK_MODIFICATIONS=False,
    SQLALCHEMY_ENGINE_OPTIONS={"pool_pre_ping": True, "pool_recycle": 300},
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("COOKIE_SECURE", "1" if os.environ.get("RENDER") else "0") == "1",
    WTF_CSRF_TIME_LIMIT=3600,
)

db = SQLAlchemy(app)
csrf = CSRFProtect(app)
limiter = Limiter(key_func=get_remote_address, app=app, default_limits=[], storage_uri="memory://")
login_manager = LoginManager(app)
login_manager.login_view = "login"
login_manager.login_message = "Please log in to use the CMH Scheduler."


class User(UserMixin, db.Model):
    __tablename__ = "users"
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    password_hash = db.Column(db.String(255), nullable=False)
    role = db.Column(db.String(20), nullable=False, default="driver")
    active = db.Column(db.Boolean, nullable=False, default=True)
    driver_id = db.Column(db.String(80), db.ForeignKey("drivers.id"), nullable=True, unique=True)

    def set_password(self, password):
        self.password_hash = generate_password_hash(password)

    def check_password(self, password):
        return check_password_hash(self.password_hash, password)


class Driver(db.Model):
    __tablename__ = "drivers"
    id = db.Column(db.String(80), primary_key=True)
    name = db.Column(db.String(120), nullable=False)
    phone = db.Column(db.String(40), default="")
    title = db.Column(db.String(80), default="Driver")
    active = db.Column(db.Boolean, default=True)
    work_days = db.Column(db.Text, default="mon,tue,wed,thu,fri")


class Patient(db.Model):
    __tablename__ = "patients"
    id = db.Column(db.String(80), primary_key=True)
    name = db.Column(db.String(160), nullable=False)
    dob = db.Column(db.String(20), default="")
    phone = db.Column(db.String(40), default="")
    address = db.Column(db.Text, default="")
    mobility = db.Column(db.String(80), default="")
    chair_width = db.Column(db.Integer, nullable=True)
    vehicle_requirement = db.Column(db.String(40), default="")
    notes = db.Column(db.Text, default="")


class Appointment(db.Model):
    __tablename__ = "appointments"
    id = db.Column(db.String(100), primary_key=True)
    patient_id = db.Column(db.String(80), db.ForeignKey("patients.id"), nullable=False, index=True)
    date = db.Column(db.String(20), nullable=False)
    medical_appointment_time = db.Column(db.String(10), default="")
    appointment_type = db.Column(db.String(80), default="Doctor Appointment")
    notes = db.Column(db.Text, default="")
    one_way = db.Column(db.Boolean, default=False)


class Trip(db.Model):
    __tablename__ = "trips"
    id = db.Column(db.String(120), primary_key=True)
    appointment_id = db.Column(db.String(100), db.ForeignKey("appointments.id", ondelete="CASCADE"), nullable=False, index=True)
    direction = db.Column(db.String(120), nullable=False)
    pickup_time = db.Column(db.String(10), default="")
    driver_id = db.Column(db.String(80), db.ForeignKey("drivers.id"), default=None, nullable=True)
    duration_minutes = db.Column(db.Integer, default=45)
    pickup_address = db.Column(db.Text, default="")
    destination = db.Column(db.Text, default="")
    status = db.Column(db.String(30), default="not-ready")
    notes = db.Column(db.Text, default="")
    trip_order = db.Column(db.Integer, default=0)


def owner_required(view):
    from functools import wraps

    @wraps(view)
    @login_required
    def wrapped(*args, **kwargs):
        if current_user.role != "owner":
            return jsonify({"ok": False, "error": "Owner access required."}), 403
        return view(*args, **kwargs)

    return wrapped


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


def driver_work_days(driver):
    return [x for x in (driver.work_days or "").split(",") if x]


def serialize_state():
    drivers = [
        {
            "id": d.id,
            "name": d.name,
            "phone": d.phone or "",
            "title": d.title or "Driver",
            "active": bool(d.active),
            "workDays": driver_work_days(d),
        }
        for d in Driver.query.order_by(Driver.name).all()
    ]

    patients = [
        {
            "id": p.id,
            "name": p.name,
            "dob": p.dob or "",
            "phone": p.phone or "",
            "address": p.address or "",
            "mobility": p.mobility or "",
            "chairWidth": p.chair_width,
            "vehicleRequirement": p.vehicle_requirement or "",
            "notes": p.notes or "",
        }
        for p in Patient.query.order_by(Patient.name).all()
    ]

    appointments = []
    for a in Appointment.query.order_by(Appointment.date, Appointment.id).all():
        trips = Trip.query.filter_by(appointment_id=a.id).order_by(Trip.trip_order, Trip.id).all()

        def trip_dict(t):
            return {
                "id": t.id,
                "pickupTime": t.pickup_time or "",
                "driverId": t.driver_id or "",
                "durationMinutes": int(t.duration_minutes or 45),
                "pickupAddress": t.pickup_address or "",
                "destination": t.destination or "",
                "status": t.status or "not-ready",
                "notes": t.notes or "",
                "direction": t.direction,
            }

        outbound = next((t for t in trips if t.direction == "Outbound"), None)
        ret = next((t for t in trips if t.direction == "Return"), None)
        additional = [trip_dict(t) for t in trips if t.direction != "Outbound" and t.direction != "Return"]

        if not outbound:
            continue

        appointments.append(
            {
                "id": a.id,
                "patientId": a.patient_id,
                "date": a.date,
                "medicalAppointmentTime": a.medical_appointment_time or "",
                "type": a.appointment_type or "Doctor Appointment",
                "notes": a.notes or "",
                "oneWay": bool(a.one_way),
                "outbound": trip_dict(outbound),
                "return": trip_dict(ret) if ret else None,
                "additionalTrips": additional,
            }
        )

    return {"drivers": drivers, "patients": patients, "appointments": appointments}


def save_state(payload):
    """Save the scheduler's current state to SQLite.

    This 0.3.4 transition intentionally accepts the existing front-end's
    complete state object so the scheduler UI can move off localStorage
    without a total rewrite. Later versions can move to smaller API calls.
    """
    payload = payload or {}

    for p in payload.get("patients", []):
        patient = db.session.get(Patient, str(p.get("id")))
        if not patient:
            patient = Patient(id=str(p.get("id")))
            db.session.add(patient)
        patient.name = p.get("name", "")
        patient.dob = p.get("dob", "")
        patient.phone = p.get("phone", "")
        patient.address = p.get("address", "")
        patient.mobility = p.get("mobility", "")
        patient.chair_width = p.get("chairWidth")
        patient.vehicle_requirement = p.get("vehicleRequirement", "")
        patient.notes = p.get("notes", "")

    for d in payload.get("drivers", []):
        driver = db.session.get(Driver, str(d.get("id")))
        if not driver:
            driver = Driver(id=str(d.get("id")))
            db.session.add(driver)
        driver.name = d.get("name", "")
        driver.phone = d.get("phone", "")
        driver.title = d.get("title", "Driver")
        driver.active = d.get("active", True) is not False
        driver.work_days = ",".join(d.get("workDays", []))

    # Appointments/trips are replaced as a single small scheduler snapshot.
    Trip.query.delete()
    Appointment.query.delete()

    for a in payload.get("appointments", []):
        appointment = Appointment(
            id=str(a.get("id")),
            patient_id=str(a.get("patientId", "")),
            date=a.get("date", ""),
            medical_appointment_time=a.get("medicalAppointmentTime", ""),
            appointment_type=a.get("type", "Doctor Appointment"),
            notes=a.get("notes", ""),
            one_way=bool(a.get("oneWay")),
        )
        db.session.add(appointment)

        trip_list = []
        outbound = a.get("outbound")
        if outbound:
            trip_list.append((0, "Outbound", outbound))
        ret = a.get("return")
        if ret:
            trip_list.append((1, "Return", ret))
        for index, t in enumerate(a.get("additionalTrips", []) or [], start=2):
            trip_list.append((index, t.get("direction") or f"Additional Trip {index - 1}", t))

        for order, direction, t in trip_list:
            db.session.add(
                Trip(
                    id=str(t.get("id")),
                    appointment_id=appointment.id,
                    direction=direction,
                    pickup_time=t.get("pickupTime", ""),
                    driver_id=(t.get("driverId") or None),
                    duration_minutes=int(t.get("durationMinutes") or 45),
                    pickup_address=t.get("pickupAddress", ""),
                    destination=t.get("destination", ""),
                    status=t.get("status") or "not-ready",
                    notes=t.get("notes", ""),
                    trip_order=order,
                )
            )

    db.session.commit()


def seed_database():
    """Create the first owner and optional demo data."""
    if User.query.first():
        return

    production = bool(os.environ.get("RENDER"))
    seed_demo = os.environ.get("SEED_DEMO_DATA", "0" if production else "1") == "1"
    admin_username = os.environ.get("ADMIN_USERNAME", "ben").strip().lower()
    admin_password = os.environ.get("ADMIN_PASSWORD")
    if not admin_password:
        if production:
            raise RuntimeError("ADMIN_PASSWORD must be set for the first production deployment.")
        admin_password = "CMHdemo123!"

    if seed_demo:
        drivers = [
            Driver(id="sarah", name="Sarah Johnson", phone="(859) 555-0101", title="Driver", active=True, work_days="mon,tue,wed,thu,fri"),
            Driver(id="mike", name="Mike Williams", phone="(859) 555-0102", title="Driver", active=True, work_days="mon,wed,fri"),
            Driver(id="john", name="John Davis", phone="(859) 555-0103", title="Driver", active=True, work_days="tue,wed,thu,sat"),
        ]
        db.session.add_all(drivers)
        db.session.flush()
        for username, password, role, driver_id in [(admin_username, admin_password, "owner", None), ("sarah", "DriverDemo123!", "driver", "sarah"), ("mike", "DriverDemo123!", "driver", "mike"), ("john", "DriverDemo123!", "driver", "john")]:
            user = User(username=username, role=role, active=True, driver_id=driver_id)
            user.set_password(password)
            db.session.add(user)
        patients = [
            Patient(id="p1", name="John Smith", dob="1954-04-12", phone="(859) 555-1234", address="123 Main Street\nLexington, KY 40508", mobility="Power Wheelchair", chair_width=24, vehicle_requirement="Silver", notes="Chair over 22 inches. Rear wheelchair position required."),
            Patient(id="p2", name="Mary Jones", dob="1948-09-22", phone="(859) 555-3333", address="789 Pine Road\nLexington, KY 40504", mobility="Wheelchair", chair_width=20, vehicle_requirement="Bronze", notes=""),
            Patient(id="p3", name="Robert Brown", dob="1951-01-18", phone="(859) 555-1111", address="123 Elm Street\nLexington, KY 40508", mobility="Stretcher", vehicle_requirement="Gold", notes="Stretcher patient. Gold vehicle required."),
            Patient(id="p4", name="Jane Williams", dob="1960-07-03", phone="(859) 555-4444", address="321 Maple Drive\nLexington, KY 40509", mobility="Walker", vehicle_requirement="Bronze", notes=""),
            Patient(id="p5", name="William Davis", dob="1946-11-30", phone="(859) 555-2222", address="456 Oak Avenue\nNicholasville, KY 40356", mobility="Geriatric Chair", vehicle_requirement="Gold", notes="Requires bench seating."),
        ]
        db.session.add_all(patients)
        db.session.flush()
        today = datetime.now().strftime("%Y-%m-%d")
        appointments = [
            ("a1", "p1", "07:45", "08:30", "sarah", 45, "11:30", "mike", 45, "123 Main Street\nLexington, KY 40508", "UK Hospital\nLexington, KY 40506", "Doctor Appointment", "Chair over 22 inches. Rear position required."),
            ("a2", "p2", "08:00", "09:00", "sarah", 60, "12:00", "sarah", 45, "789 Pine Road\nLexington, KY 40504", "UK Hospital\nLexington, KY 40506", "Doctor Appointment", "Same destination as John. Shared transportation is intentional."),
            ("a3", "p3", "09:30", "10:30", "john", 60, "13:00", "mike", 60, "123 Elm Street\nLexington, KY 40508", "VA Clinic\nLexington, KY 40505", "Procedure", "Stretcher patient."),
            ("a4", "p4", "10:30", "11:30", "sarah", 60, "14:00", "john", 45, "321 Maple Drive\nLexington, KY 40509", "Bluegrass Clinic\nLexington, KY 40508", "Therapy", ""),
            ("a5", "p5", "13:30", "14:30", "mike", 60, "16:00", "mike", 45, "456 Oak Avenue\nNicholasville, KY 40356", "Baptist Health\nLexington, KY 40508", "Procedure", "Requires bench seating."),
        ]
        for values in appointments:
            aid, pid, out_pick, med, out_driver, out_dur, ret_pick, ret_driver, ret_dur, pickup, dest, typ, notes = values
            db.session.add(Appointment(id=aid, patient_id=pid, date=today, medical_appointment_time=med, appointment_type=typ, notes=notes, one_way=False))
            db.session.add(Trip(id=aid + "-out", appointment_id=aid, direction="Outbound", pickup_time=out_pick, driver_id=out_driver, duration_minutes=out_dur, pickup_address=pickup, destination=dest, status="not-ready", trip_order=0))
            db.session.add(Trip(id=aid + "-return", appointment_id=aid, direction="Return", pickup_time=ret_pick, driver_id=ret_driver, duration_minutes=ret_dur, pickup_address=dest, destination=pickup, status="not-ready", trip_order=1))
    else:
        owner = User(username=admin_username, role="owner", active=True)
        owner.set_password(admin_password)
        db.session.add(owner)
    db.session.commit()


@app.after_request
def add_security_headers(response):
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    if request.is_secure or os.environ.get("RENDER"):
        response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    return response


@app.context_processor
def inject_app_data():
    if current_user.is_authenticated:
        user_data = {
            "id": current_user.id,
            "username": current_user.username,
            "role": current_user.role,
            "driverId": current_user.driver_id,
        }
        return {"app_data": serialize_state(), "current_user_data": user_data}
    return {"app_data": {"drivers": [], "patients": [], "appointments": []}, "current_user_data": None}


@app.before_request
def ensure_database():
    db.create_all()
    seed_database()


@app.route("/login", methods=["GET", "POST"])
@limiter.limit("10 per minute", methods=["POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("today"))
    if request.method == "POST":
        username = request.form.get("username", "").strip().lower()
        password = request.form.get("password", "")
        user = User.query.filter_by(username=username, active=True).first()
        if user and user.check_password(password):
            login_user(user)
            return redirect(request.args.get("next") or url_for("today"))
        flash("Incorrect username or password.", "error")
    return render_template("login.html")


@app.route("/logout")
@login_required
def logout():
    logout_user()
    return redirect(url_for("login"))


@app.route("/users", methods=["GET", "POST"])
@owner_required
def users():
    if request.method == "POST":
        username = request.form.get("username", "").strip().lower()
        password = request.form.get("password", "")
        role = request.form.get("role", "driver")
        driver_id = request.form.get("driver_id", "").strip() or None
        if not username or len(username) < 3:
            flash("Username must be at least 3 characters.", "error")
        elif len(password) < 12:
            flash("Password must be at least 12 characters.", "error")
        elif role not in {"owner", "driver"}:
            flash("Invalid role.", "error")
        elif User.query.filter_by(username=username).first():
            flash("That username already exists.", "error")
        elif driver_id and not db.session.get(Driver, driver_id):
            flash("Selected driver does not exist.", "error")
        else:
            user = User(username=username, role=role, active=True, driver_id=driver_id if role == "driver" else None)
            user.set_password(password)
            db.session.add(user)
            db.session.commit()
            flash(f"User {username} created.", "success")
    return render_template("users.html", users=User.query.order_by(User.username).all(), drivers=Driver.query.order_by(Driver.name).all())


@app.route("/account", methods=["GET", "POST"])
@login_required
def account():
    if request.method == "POST":
        current_password = request.form.get("current_password", "")
        new_password = request.form.get("new_password", "")
        confirm = request.form.get("confirm_password", "")
        if not current_user.check_password(current_password):
            flash("Current password is incorrect.", "error")
        elif len(new_password) < 12:
            flash("New password must be at least 12 characters.", "error")
        elif new_password != confirm:
            flash("New passwords do not match.", "error")
        else:
            current_user.set_password(new_password)
            db.session.commit()
            flash("Password changed successfully.", "success")
    return render_template("account.html")


@app.route("/api/reset", methods=["POST"])
@login_required
def api_reset():
    if current_user.role != "owner":
        return jsonify({"ok": False, "error": "Owner access required."}), 403
    try:
        Trip.query.delete()
        Appointment.query.delete()
        Patient.query.delete()
        Driver.query.delete()
        User.query.delete()
        db.session.commit()
        seed_database()
        return jsonify({"ok": True})
    except Exception as exc:
        db.session.rollback()
        app.logger.exception("Could not reset demo data")
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/state", methods=["POST"])
@login_required
def api_state():
    if not request.is_json:
        return jsonify({"ok": False, "error": "JSON required"}), 400
    try:
        save_state(request.get_json())
        return jsonify({"ok": True})
    except Exception as exc:
        db.session.rollback()
        app.logger.exception("Could not save scheduler state")
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/health")
def health():
    try:
        db.session.execute(db.text("SELECT 1"))
        return jsonify({"ok": True, "database": "ok"})
    except Exception:
        app.logger.exception("Health check database failure")
        return jsonify({"ok": False, "database": "error"}), 503


@app.route("/")
@login_required
def today():
    return render_template("today.html")


@app.route("/calendar")
@login_required
def calendar():
    return render_template("calendar.html")


@app.route("/patients")
@login_required
def patients():
    return render_template("patients.html")


@app.route("/patient/new")
@login_required
def new_patient():
    return render_template("patients.html")


@app.route("/patient/<patient_id>")
@login_required
def patient(patient_id):
    return render_template("patient.html", patient_id=patient_id)


@app.route("/appointment/new")
@login_required
def new_appointment():
    return render_template("appointment_form.html")


@app.route("/appointment/<appointment_id>")
@login_required
def appointment(appointment_id):
    return render_template("appointment.html", appointment_id=appointment_id)


@app.route("/drivers")
@login_required
def drivers():
    return render_template("drivers.html")


@app.route("/driver")
@login_required
def driver():
    return render_template("driver.html")


with app.app_context():
    db.create_all()
    seed_database()


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)

import requests
from bs4 import BeautifulSoup
import re
import time
import os
import unicodedata
from supabase import create_client, Client
from dotenv import load_dotenv

# Load environment variables from .env file
load_dotenv()
supabase_url = os.getenv('SUPABASE_URL')
supabase_key = os.getenv('SUPABASE_KEY')
if not supabase_url or not supabase_key:
    raise ValueError("SUPABASE_URL and SUPABASE_KEY must be set in .env file.")

supabase: Client = create_client(supabase_url, supabase_key)

# Base URL for the UW Seattle course catalog
base_url = 'https://www.washington.edu/students/crscat/'

# Fetch the main catalog page to get department links
main_page = requests.get(base_url)
main_soup = BeautifulSoup(main_page.text, 'html.parser')

# Find all department links (href like 'anth.html', excluding glossary.html)
departments = []
for a in main_soup.find_all('a'):
    href = a.get('href')
    if href and href.endswith('.html') and 'glossary' not in href and '/' not in href and len(href) > 5:
        dep_abbrev = href[:-5]
        dep_name = a.text.strip()  # e.g., "Anthropology (ANTH)"
        dep_url = base_url + href
        departments.append((dep_abbrev, dep_name, dep_url))

print(f"Found {len(departments)} departments.")

# Regex pattern to parse course header
# Example headers to match:
#   "ANTH 100 Introduction to Anthropology (5) SSc"
#   "L ARCH 300 Advanced Landscape Topics (5) I&S"
#   "B E 200 Built Environment Foundations (5)"
# Allow department codes with internal spaces: e.g., "L ARCH", "B E".
# Capture the entire subject+number (e.g., "L ARCH 300") as 'code'.
header_pattern = re.compile(
    r'^(?P<code>[A-Z]+(?:\s+[A-Z]+)*\s+\d+[A-Z]?)\s+(?P<title>.+?)\s*\((?P<credits>[^)]*)\)\s*(?P<tags>.*)?$'
)

# Iterate over each department
for dep_abbrev, dep_name, dep_url in departments:
    print(f"Scraping {dep_name}...")
    
    dep_page = requests.get(dep_url)
    dep_soup = BeautifulSoup(dep_page.text, 'html.parser')
    
    courses = []
    
    # Find all <p> tags that contain a <b> (course entries)
    for p in dep_soup.find_all('p'):
        b = p.find('b')
        if b:
            full_text = p.get_text().strip()
            lines = [line.strip() for line in full_text.split('\n') if line.strip()]
            if not lines:
                continue
            
            header = lines[0]
            # Normalize unicode and whitespace to make regex matching robust
            header_norm = unicodedata.normalize('NFKC', header).replace('\xa0', ' ')
            header_norm = re.sub(r'\s+', ' ', header_norm).strip()
            match = header_pattern.match(header_norm)
            if match:
                code_clean = match.group('code').replace(' ', '')
                course_data = {
                    'code': code_clean,
                    'title': match.group('title'),
                    'credits': match.group('credits')
                }
                courses.append(course_data)
    
    # Insert courses into Supabase (batch insert)
    if courses:
        response = supabase.table('uw_courses').insert(courses).execute()
        if hasattr(response, 'error') and response.error:
            print(f"Error inserting courses for {dep_name}: {response.error}")
        else:
            print(f"Inserted {len(courses)} courses for {dep_name}.")
    
    # Delay to avoid rate limiting
    time.sleep(0.1)

print("Scraping complete.")